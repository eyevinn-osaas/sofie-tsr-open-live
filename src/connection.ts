import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import type { OpenLiveOptions } from './types'
import type { OpenLiveFrame } from './state'

/** Fixed OSC token-exchange endpoint (same as open-live's src/lib/osc-token.ts). */
export const OSC_TOKEN_EXCHANGE_URL = 'https://token.svc.prod.osaas.io/servicetoken'
const DEFAULT_OSC_SERVICE_ID = 'eyevinn-open-live'
/**
 * Gateway environment variables for credentials. The playout gateway logs every
 * device's options at startup, so a token kept in the device settings ends up in
 * plain text in the gateway log. Keep it here instead.
 */
export const OSC_PAT_ENV = 'OPEN_LIVE_OSC_PAT'
export const OPEN_LIVE_API_KEY_ENV = 'OPEN_LIVE_API_KEY'
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15000

/** A frame sent by Open Live. Every state event carries seq/ts (automation contract §2). */
export type OpenLiveEvent = { type: string; seq?: number; ts?: string } & Record<string, any>

export interface CommandResult {
	/** 'executed' when Open Live confirmed it, 'accepted' when only validation was confirmed before the timeout */
	phase: 'executed' | 'accepted'
	latencyMs: number
}

export class CommandRejectedError extends Error {
	constructor(readonly frame: OpenLiveFrame, readonly reason: string) {
		super(`Open Live rejected ${frame.type}: ${reason}`)
		this.name = 'CommandRejectedError'
	}
}

export class CommandTimeoutError extends Error {
	constructor(readonly frame: OpenLiveFrame, timeoutMs: number) {
		super(`No ACK from Open Live for ${frame.type} within ${timeoutMs} ms`)
		this.name = 'CommandTimeoutError'
	}
}

interface Pending {
	frame: OpenLiveFrame
	sentAt: number
	accepted: boolean
	resolve: (r: CommandResult) => void
	reject: (e: Error) => void
	timer: NodeJS.Timeout
}

export interface OpenLiveConnectionEvents {
	/** HELLO … SNAPSHOT_END finished; `snapshot` holds every frame in between, in order */
	ready: [hello: OpenLiveEvent, snapshot: OpenLiveEvent[]]
	/** A live state event after the snapshot */
	event: [event: OpenLiveEvent]
	disconnected: [reason: string]
	error: [context: string, err: Error]
	warning: [message: string]
}

export function controllerUrl(baseUrl: string, productionId: string): string {
	const u = new URL(baseUrl)
	u.protocol = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : 'wss:'
	u.pathname = `${u.pathname.replace(/\/$/, '')}/ws/productions/${encodeURIComponent(productionId)}/controller`
	u.search = ''
	return u.toString()
}

/**
 * Exchange an OSC Personal Access Token for a Service Access Token.
 * Mirrors open-live's exchangeServiceToken().
 */
export async function exchangeOscToken(
	pat: string,
	serviceId: string,
	fetchImpl: typeof fetch = fetch
): Promise<{ token: string; expiry: number }> {
	const res = await fetchImpl(OSC_TOKEN_EXCHANGE_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', accept: 'application/json', 'x-pat-jwt': `Bearer ${pat}` },
		body: JSON.stringify({ serviceId }),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => '')
		throw new Error(`OSC SAT exchange failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`)
	}
	const data = (await res.json()) as { token?: unknown; expiry?: unknown }
	if (typeof data.token !== 'string' || typeof data.expiry !== 'number') {
		throw new Error('OSC token service returned a malformed response')
	}
	return { token: data.token, expiry: data.expiry }
}

/**
 * Operator connection to one Open Live production's controller WebSocket.
 * Handles auth, the connect snapshot, two-phase ACK correlation, keep-alive and reconnect.
 */
export class OpenLiveConnection extends EventEmitter<OpenLiveConnectionEvents> {
	private ws: WebSocket | undefined
	private pending = new Map<string, Pending>()
	private snapshot: OpenLiveEvent[] | undefined
	private hello: OpenLiveEvent | undefined
	private ready = false
	private closing = false
	private reconnectDelay = RECONNECT_MIN_MS
	private reconnectTimer: NodeJS.Timeout | undefined
	private keepAliveTimer: NodeJS.Timeout | undefined
	private sat: { token: string; expiry: number } | undefined

	constructor(
		private readonly options: OpenLiveOptions,
		private readonly deps: { fetch?: typeof fetch; WebSocketImpl?: typeof WebSocket; env?: NodeJS.ProcessEnv } = {}
	) {
		super()
	}

	private get env(): NodeJS.ProcessEnv {
		return this.deps.env ?? process.env
	}

	get connected(): boolean {
		return this.ready
	}

	get contractVersion(): string | undefined {
		return this.hello?.contractVersion
	}

	async connect(): Promise<void> {
		this.closing = false
		await this.open()
	}

	async close(): Promise<void> {
		this.closing = true
		clearTimeout(this.reconnectTimer)
		clearInterval(this.keepAliveTimer)
		this.failAllPending('connection closed')
		const ws = this.ws
		this.ws = undefined
		if (ws && ws.readyState !== WebSocket.CLOSED) {
			await new Promise<void>((resolve) => {
				ws.once('close', () => resolve())
				ws.close(1000)
				setTimeout(resolve, 1000).unref()
			})
		}
	}

	/** Send a command and wait for Open Live's ACK executed (or NACK). */
	send(frame: OpenLiveFrame): Promise<CommandResult> {
		if (!this.ws || !this.ready) return Promise.reject(new Error(`Not connected; dropped ${frame.type}`))
		const cmdId = randomUUID()
		const timeoutMs = this.options.ackTimeoutMs ?? 5000
		return new Promise<CommandResult>((resolve, reject) => {
			const sentAt = Date.now()
			const timer = setTimeout(() => {
				const p = this.pending.get(cmdId)
				this.pending.delete(cmdId)
				// accepted but never reported executed: treat as done, the device will
				// see the resulting state event. Nothing at all is a real failure.
				if (p?.accepted) resolve({ phase: 'accepted', latencyMs: Date.now() - sentAt })
				else reject(new CommandTimeoutError(frame, timeoutMs))
			}, timeoutMs)
			this.pending.set(cmdId, { frame, sentAt, accepted: false, resolve, reject, timer })
			this.ws!.send(JSON.stringify({ ...frame, cmdId }), (err) => {
				if (!err) return
				clearTimeout(timer)
				this.pending.delete(cmdId)
				reject(err)
			})
		})
	}

	private async authenticate(): Promise<{ headers: Record<string, string>; protocols: string[] }> {
		switch (this.options.authMode ?? 'none') {
			case 'apiKey': {
				const apiKey = this.options.apiKey || this.env[OPEN_LIVE_API_KEY_ENV]
				if (!apiKey) throw new Error(`authMode apiKey needs apiKey (device setting or ${OPEN_LIVE_API_KEY_ENV})`)
				return { headers: { Authorization: `Bearer ${apiKey}` }, protocols: [] }
			}
			case 'osc': {
				const pat = this.options.oscPat || this.env[OSC_PAT_ENV]
				if (!pat) throw new Error(`authMode osc needs an OSC token (${OSC_PAT_ENV} on the gateway, or oscPat)`)
				// Refresh a minute before expiry; the SAT is only checked at upgrade time.
				if (!this.sat || this.sat.expiry * 1000 - Date.now() < 60_000) {
					this.sat = await exchangeOscToken(
						pat,
						this.options.oscServiceId || DEFAULT_OSC_SERVICE_ID,
						this.deps.fetch
					)
				}
				return { headers: {}, protocols: ['osc.bearer', `osc.bearer.${this.sat.token}`] }
			}
			default:
				return { headers: {}, protocols: [] }
		}
	}

	private async open(): Promise<void> {
		let auth: { headers: Record<string, string>; protocols: string[] }
		try {
			auth = await this.authenticate()
		} catch (e) {
			this.emit('error', 'Open Live auth', e as Error)
			this.scheduleReconnect()
			return
		}
		const WS = this.deps.WebSocketImpl ?? WebSocket
		const url = controllerUrl(this.options.url, this.options.productionId)
		const ws = new WS(url, auth.protocols, { headers: auth.headers, handshakeTimeout: 10_000 })
		this.ws = ws
		this.snapshot = undefined
		this.hello = undefined

		ws.on('message', (data) => this.onMessage(data.toString()))
		ws.on('error', (err) => this.emit('error', 'Open Live WebSocket', err))
		ws.on('unexpected-response', (_req, res) => {
			this.emit('error', 'Open Live WebSocket', new Error(`Upgrade rejected: HTTP ${res.statusCode}`))
		})
		ws.on('close', (code, reason) => {
			if (this.ws !== ws) return
			this.ws = undefined
			const wasReady = this.ready
			this.ready = false
			clearInterval(this.keepAliveTimer)
			this.failAllPending('connection lost')
			if (wasReady) this.emit('disconnected', `closed ${code} ${reason.toString()}`.trim())
			this.scheduleReconnect()
		})
	}

	private scheduleReconnect(): void {
		if (this.closing) return
		clearTimeout(this.reconnectTimer)
		const delay = this.reconnectDelay
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
		this.reconnectTimer = setTimeout(() => void this.open(), delay)
	}

	private onMessage(raw: string): void {
		let msg: OpenLiveEvent
		try {
			msg = JSON.parse(raw)
		} catch {
			this.emit('warning', `Unparseable frame from Open Live: ${raw.slice(0, 100)}`)
			return
		}

		switch (msg.type) {
			case 'HELLO':
				this.hello = msg
				this.snapshot = []
				if (typeof msg.contractVersion === 'string' && !msg.contractVersion.startsWith('1.')) {
					this.emit('warning', `Open Live contract ${msg.contractVersion}; this plugin targets 1.x`)
				}
				return
			case 'SNAPSHOT_END':
				this.ready = true
				this.reconnectDelay = RECONNECT_MIN_MS
				this.startKeepAlive()
				this.emit('ready', this.hello ?? { type: 'HELLO' }, this.snapshot ?? [])
				this.snapshot = undefined
				return
			case 'ACK': {
				const p = this.pending.get(msg.cmdId)
				if (!p) return
				if (msg.phase === 'accepted') {
					p.accepted = true
					return
				}
				clearTimeout(p.timer)
				this.pending.delete(msg.cmdId)
				p.resolve({ phase: 'executed', latencyMs: Date.now() - p.sentAt })
				return
			}
			case 'NACK': {
				const p = this.pending.get(msg.cmdId)
				if (!p) return
				clearTimeout(p.timer)
				this.pending.delete(msg.cmdId)
				p.reject(new CommandRejectedError(p.frame, String(msg.error)))
				return
			}
			case 'METER_DATA':
			case 'LOUDNESS_DATA':
				return
		}

		if (this.snapshot) this.snapshot.push(msg)
		else this.emit('event', msg)
	}

	private startKeepAlive(): void {
		clearInterval(this.keepAliveTimer)
		const interval = this.options.keepAliveIntervalMs ?? 30_000
		if (interval <= 0) return
		this.keepAliveTimer = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'KEEP_ALIVE' }))
		}, interval)
	}

	private failAllPending(reason: string): void {
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer)
			p.reject(new Error(`${p.frame.type} not confirmed: ${reason}`))
			this.pending.delete(id)
		}
	}
}
