import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { OpenLiveDevice, stateFromSnapshot } from '../device'
import { controllerUrl, exchangeOscToken, OSC_TOKEN_EXCHANGE_URL } from '../connection'
import type { OpenLiveState } from '../state'

/** Minimal stand-in for Open Live's controller WebSocket (automation contract 1.0.0). */
class FakeOpenLive {
	readonly wss: WebSocketServer
	readonly received: any[] = []
	readonly upgrades: Array<{ url?: string; auth?: string; protocol?: string }> = []
	sockets: WebSocket[] = []
	nack: Record<string, string> = {}
	/** Command types answered with ACK accepted only (like Open Live's CLIP_* commands) */
	acceptOnly = new Set<string>()
	/** Command types NACKed after an ACK accepted */
	lateNack: Record<string, string> = {}
	seq = 0

	constructor(private snapshot: any[]) {
		this.wss = new WebSocketServer({ port: 0, handleProtocols: (p) => (p.has('osc.bearer') ? 'osc.bearer' : false) })
		this.wss.on('connection', (ws, req) => {
			this.upgrades.push({
				url: req.url,
				auth: req.headers.authorization,
				protocol: req.headers['sec-websocket-protocol'] as string | undefined,
			})
			this.sockets.push(ws)
			const send = (m: any) => ws.send(JSON.stringify({ ...m, seq: ++this.seq, ts: new Date().toISOString() }))
			send({ type: 'HELLO', contractVersion: '1.0.0', productionId: 'p1' })
			for (const m of this.snapshot) send(m)
			send({ type: 'SNAPSHOT_END' })
			ws.on('message', (raw) => {
				const msg = JSON.parse(raw.toString())
				this.received.push(msg)
				if (!msg.cmdId) return
				if (this.nack[msg.type]) return send({ type: 'NACK', cmdId: msg.cmdId, error: this.nack[msg.type] })
				send({ type: 'ACK', cmdId: msg.cmdId, phase: 'accepted' })
				if (this.acceptOnly.has(msg.type)) return
				if (this.lateNack[msg.type]) return send({ type: 'NACK', cmdId: msg.cmdId, error: this.lateNack[msg.type] })
				send({ type: 'ACK', cmdId: msg.cmdId, phase: 'executed' })
			})
		})
	}
	get url() {
		return `http://127.0.0.1:${(this.wss.address() as AddressInfo).port}`
	}
	close() {
		for (const s of this.sockets) s.terminate()
		return new Promise((r) => this.wss.close(r))
	}
}

function fakeContext() {
	const ctx = {
		deviceName: 'test',
		logger: { error: jest.fn(), warning: jest.fn(), info: jest.fn(), debug: jest.fn() },
		connectionChanged: jest.fn(),
		resetToState: jest.fn(),
		resetState: jest.fn(),
		resetResolver: jest.fn(),
		commandError: jest.fn(),
	}
	return ctx
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
	const end = Date.now() + ms
	while (!cond()) {
		if (Date.now() > end) throw new Error('timeout')
		await new Promise((r) => setTimeout(r, 10))
	}
}

describe('controllerUrl', () => {
	test('maps http(s) base URLs to the controller WS path', () => {
		expect(controllerUrl('https://x.osaas.io', 'abc')).toBe('wss://x.osaas.io/ws/productions/abc/controller')
		expect(controllerUrl('http://localhost:3000/', 'a b')).toBe('ws://localhost:3000/ws/productions/a%20b/controller')
	})
})

describe('stateFromSnapshot', () => {
	test('rebuilds controlled state from the connect snapshot', () => {
		const s = stateFromSnapshot([
			{ type: 'TALLY', pgm: 'video_in_1', pvw: 'video_in_2' },
			{ type: 'DSK_STATE', layer: 1, visible: true },
			{ type: 'GRAPHIC_STATE', graphics: [{ overlayId: 'l3', active: true }] },
			{ type: 'AUDIO_STATE', elementId: 'ch1', property: 'volume', value: 0.7 },
			{ type: 'AUDIO_STATE', elementId: 'ch1', property: 'mute', value: false },
			{ type: 'CLIP_STATE', mixerInput: 'video_in_5', state: 'playing', clipId: 'c1' },
		])
		expect(s).toMatchObject<Partial<OpenLiveState>>({
			program: { objId: '', input: 'video_in_1' },
			preview: { objId: '', input: 'video_in_2' },
			dsk: { 1: { objId: '', visible: true } },
			graphics: { l3: { objId: '', active: true } },
			audio: { ch1: { objId: '', volume: 0.7, muted: false } },
			clips: { video_in_5: { objId: '', active: true, clipId: 'c1', playing: true } },
		})
	})
})

describe('exchangeOscToken', () => {
	test('posts the PAT to the fixed OSC endpoint', async () => {
		const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'sat', expiry: 9e9 }) })
		await expect(exchangeOscToken('pat', 'eyevinn-open-live', fetchMock as any)).resolves.toEqual({ token: 'sat', expiry: 9e9 })
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe(OSC_TOKEN_EXCHANGE_URL)
		expect(init.headers['x-pat-jwt']).toBe('Bearer pat')
		expect(JSON.parse(init.body)).toEqual({ serviceId: 'eyevinn-open-live' })
	})
})

describe('OpenLiveDevice against a fake Open Live', () => {
	let server: FakeOpenLive
	let device: OpenLiveDevice
	let ctx: ReturnType<typeof fakeContext>

	beforeEach(() => {
		server = new FakeOpenLive([{ type: 'TALLY', pgm: 'video_in_1', pvw: null }])
		ctx = fakeContext()
		device = new OpenLiveDevice(ctx as any)
	})
	afterEach(async () => {
		await device.terminate()
		await server.close()
	})

	test('connects with an API key, resets to the snapshot, and sends commands with cmdIds', async () => {
		await device.init({ url: server.url, productionId: 'p1', authMode: 'apiKey', apiKey: 'k', keepAliveIntervalMs: 0 })
		await waitFor(() => device.connected)
		expect(server.upgrades[0]).toMatchObject({ url: '/ws/productions/p1/controller', auth: 'Bearer k' })
		expect(ctx.resetToState).toHaveBeenCalledWith(expect.objectContaining({ program: { objId: '', input: 'video_in_1' } }))

		await device.sendCommand({ command: { type: 'CUT', mixerInput: 'video_in_2' }, context: 'test', timelineObjId: 'o1' })
		expect(server.received[0]).toMatchObject({ type: 'CUT', mixerInput: 'video_in_2', cmdId: expect.any(String) })
		expect(ctx.commandError).not.toHaveBeenCalled()
	})

	test('reports a NACK as a command error', async () => {
		server.nack.CUT = 'unknown mixerInput'
		await device.init({ url: server.url, productionId: 'p1', keepAliveIntervalMs: 0 })
		await waitFor(() => device.connected)
		await device.sendCommand({ command: { type: 'CUT', mixerInput: 'nope' }, context: 'test', timelineObjId: 'o1' })
		expect(ctx.commandError).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Open Live rejected CUT: unknown mixerInput' }),
			expect.objectContaining({ timelineObjId: 'o1' })
		)
	})

	test('offers the osc.bearer subprotocol pair in OSC mode', async () => {
		const realFetch = global.fetch
		global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'the-sat', expiry: 9e9 }) }) as any
		try {
			await device.init({ url: server.url, productionId: 'p1', authMode: 'osc', oscPat: 'pat', keepAliveIntervalMs: 0 })
			await waitFor(() => device.connected)
			expect(server.upgrades[0].protocol).toBe('osc.bearer,osc.bearer.the-sat')
		} finally {
			global.fetch = realFetch
		}
	})

	test('takes the OSC token from OPEN_LIVE_OSC_PAT when the device setting is empty', async () => {
		const realFetch = global.fetch
		const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'env-sat', expiry: 9e9 }) })
		global.fetch = fetchMock as any
		process.env.OPEN_LIVE_OSC_PAT = 'env-pat'
		try {
			await device.init({ url: server.url, productionId: 'p1', authMode: 'osc', keepAliveIntervalMs: 0 })
			await waitFor(() => device.connected)
			expect(fetchMock.mock.calls[0][1].headers['x-pat-jwt']).toBe('Bearer env-pat')
			expect(server.upgrades[0].protocol).toBe('osc.bearer,osc.bearer.env-sat')
		} finally {
			global.fetch = realFetch
			delete process.env.OPEN_LIVE_OSC_PAT
		}
	})

	test('reports a non-empty status message when connected', async () => {
		await device.init({ url: server.url, productionId: 'p1', keepAliveIntervalMs: 0 })
		await waitFor(() => device.connected)
		expect(device.getStatus()).toEqual({ statusCode: 1, messages: ['Connected to production p1'] })
	})

	test('reconnects and resyncs after the socket drops', async () => {
		await device.init({ url: server.url, productionId: 'p1', keepAliveIntervalMs: 0 })
		await waitFor(() => device.connected)
		server.sockets[0].terminate()
		await waitFor(() => !device.connected)
		await waitFor(() => device.connected, 5000)
		expect(ctx.resetToState).toHaveBeenCalledTimes(2)
		expect(server.upgrades).toHaveLength(2)
	})

	test('a command that is only accepted does not hold back the next one', async () => {
		server.acceptOnly.add('CLIP_PLAY')
		await device.init({ url: server.url, productionId: 'p1', keepAliveIntervalMs: 0, ackTimeoutMs: 5000 })
		await waitFor(() => device.connected)
		const t0 = Date.now()
		await device.sendCommand({ command: { type: 'CLIP_PLAY', mixerInput: 'video_in_6' }, context: 'clip', timelineObjId: 'o1' })
		await device.sendCommand({ command: { type: 'CUT', mixerInput: 'video_in_6' }, context: 'cut', timelineObjId: 'o2' })
		expect(Date.now() - t0).toBeLessThan(1000)
		expect(server.received.map((m) => m.type)).toEqual(['CLIP_PLAY', 'CUT'])
		expect(ctx.commandError).not.toHaveBeenCalled()
	})

	test('reports a NACK that arrives after ACK accepted', async () => {
		server.lateNack.CUT = 'strom call failed'
		await device.init({ url: server.url, productionId: 'p1', keepAliveIntervalMs: 0 })
		await waitFor(() => device.connected)
		await device.sendCommand({ command: { type: 'CUT', mixerInput: 'video_in_1' }, context: 'cut', timelineObjId: 'o1' })
		await waitFor(() => ctx.commandError.mock.calls.length > 0)
		expect(ctx.commandError).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Open Live rejected CUT: strom call failed' }),
			expect.objectContaining({ timelineObjId: 'o1' })
		)
	})

	test('runMacro action sends MACRO_EXEC', async () => {
		await device.init({ url: server.url, productionId: 'p1', keepAliveIntervalMs: 0 })
		await waitFor(() => device.connected)
		const res = await device.actions.runMacro({ macroId: 'opening' })
		expect(res.result).toBe('OK')
		expect(server.received[0]).toMatchObject({ type: 'MACRO_EXEC', macroId: 'opening' })
	})
})
