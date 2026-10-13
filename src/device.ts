import type { DeviceContextAPI, Device, DeviceStatusInput, DeviceTimelineState } from 'timeline-state-resolver-api'
import { StatusCode } from 'timeline-state-resolver-api'
import { ActionExecutionResultCode, type ActionExecutionResult, type Mappings } from 'timeline-state-resolver-types'
import { OpenLiveConnection, type OpenLiveEvent } from './connection'
import {
	convertTimelineStateToDeviceState,
	diffStates,
	emptyState,
	type OpenLiveCommandWithContext,
	type OpenLiveState,
} from './state'
import { OpenLiveActions, type OpenLiveOptions, type SomeMappingOpenLive } from './types'

export interface OpenLiveActionMethods {
	[OpenLiveActions.Resync]: (payload: Record<string, never>) => Promise<ActionExecutionResult>
	[OpenLiveActions.RunMacro]: (payload: { macroId: string }) => Promise<ActionExecutionResult>
}

export interface OpenLiveDeviceTypes {
	Options: OpenLiveOptions
	Mappings: SomeMappingOpenLive
	Actions: OpenLiveActionMethods
}

/** Rebuild the controlled parts of a production from the connect-time snapshot. */
export function stateFromSnapshot(snapshot: OpenLiveEvent[]): OpenLiveState {
	const state = emptyState()
	for (const ev of snapshot) {
		switch (ev.type) {
			case 'TALLY':
				if (typeof ev.pgm === 'string') state.program = { objId: '', input: ev.pgm }
				if (typeof ev.pvw === 'string') state.preview = { objId: '', input: ev.pvw }
				break
			case 'DSK_STATE':
				state.dsk[ev.layer] = { objId: '', visible: !!ev.visible }
				break
			case 'GRAPHIC_STATE':
				for (const g of ev.graphics ?? []) state.graphics[g.overlayId] = { objId: '', active: !!g.active }
				break
			case 'GRAPHIC':
				state.graphics[ev.overlayId] = { objId: '', active: !!ev.active }
				break
			case 'AUDIO_STATE': {
				const a = (state.audio[ev.elementId] ??= { objId: '' })
				if (ev.property === 'volume' && typeof ev.value === 'number') a.volume = ev.value
				if (ev.property === 'mute') a.muted = !!ev.value
				break
			}
			case 'CLIP_STATE': {
				const active = ev.state === 'cued' || ev.state === 'playing' || ev.state === 'paused'
				state.clips[ev.mixerInput] = { objId: '', active, clipId: ev.clipId, playing: ev.state === 'playing' }
				break
			}
			case 'ON_AIR':
				state.onAir = { objId: '', value: !!ev.value }
				break
			case 'FTB_STATE':
				state.ftb = { objId: '', active: !!ev.active }
				break
		}
	}
	return state
}

/**
 * Sofie TSR device for one Open Live production.
 * Talks the Open Live automation control contract (open-live#209) over the controller WebSocket.
 */
export class OpenLiveDevice implements Device<OpenLiveDeviceTypes, OpenLiveState, OpenLiveCommandWithContext> {
	readonly actions: OpenLiveActionMethods = {
		[OpenLiveActions.Resync]: async () => {
			this.context.resetResolver()
			return { result: ActionExecutionResultCode.Ok }
		},
		[OpenLiveActions.RunMacro]: async (payload) => this.runAction({ type: 'MACRO_EXEC', macroId: payload.macroId }),
	}

	private connection: OpenLiveConnection | undefined
	private lastError: string | undefined
	private productionId = ''

	constructor(private readonly context: DeviceContextAPI<OpenLiveDeviceTypes, OpenLiveState>) {}

	async init(options: OpenLiveOptions): Promise<boolean> {
		this.productionId = options.productionId
		const conn = new OpenLiveConnection(options)
		this.connection = conn

		conn.on('ready', (hello, snapshot) => {
			this.lastError = undefined
			this.context.logger.info(
				`Connected to Open Live production ${options.productionId} (contract ${hello.contractVersion ?? 'unknown'})`
			)
			this.context.connectionChanged(this.getStatus())
			// Diff from what Open Live actually shows, so only the differences get sent.
			this.context.resetToState(stateFromSnapshot(snapshot))
		})
		conn.on('disconnected', (reason) => {
			this.context.logger.warning(`Open Live disconnected: ${reason}`)
			this.context.connectionChanged(this.getStatus())
		})
		conn.on('error', (ctx, err) => {
			this.lastError = err.message
			this.context.logger.error(ctx, err)
			this.context.connectionChanged(this.getStatus())
		})
		conn.on('warning', (msg) => this.context.logger.warning(msg))

		// Do not wait for the socket: TSR expects init to return and the device to come up later.
		void conn.connect()
		return true
	}

	async terminate(): Promise<void> {
		await this.connection?.close()
		this.connection?.removeAllListeners()
		this.connection = undefined
	}

	get connected(): boolean {
		return this.connection?.connected ?? false
	}

	getStatus(): DeviceStatusInput {
		// Always send a message: Sofie keeps showing the previous one when the list is empty.
		if (this.connected) return { statusCode: StatusCode.GOOD, messages: [`Connected to production ${this.productionId}`] }
		return {
			statusCode: StatusCode.BAD,
			messages: [this.lastError ? `Not connected to Open Live: ${this.lastError}` : 'Not connected to Open Live'],
		}
	}

	convertTimelineStateToDeviceState(state: DeviceTimelineState, mappings: Mappings): OpenLiveState {
		return convertTimelineStateToDeviceState(state, mappings)
	}

	diffStates(oldState: OpenLiveState | undefined, newState: OpenLiveState): OpenLiveCommandWithContext[] {
		// While disconnected nothing is sent; the snapshot on reconnect resets the state.
		if (!this.connected) return []
		return diffStates(oldState, newState)
	}

	async sendCommand(cwc: OpenLiveCommandWithContext): Promise<void> {
		this.context.logger.debug(cwc)
		if (!this.connection?.connected) return
		const { accepted, executed } = this.connection.send(cwc.command)
		try {
			// Only wait for validation: TSR needs commands sent in order, not executed in
			// order, and waiting for execution delayed the next cut by ackTimeoutMs.
			await accepted
		} catch (e) {
			this.context.commandError(e as Error, cwc)
			return
		}
		executed.then(
			(res) => {
				if (res.phase === 'accepted') this.context.logger.debug(`${cwc.command.type} not confirmed executed (${cwc.context})`)
			},
			(e) => this.context.commandError(e as Error, cwc)
		)
	}

	private async runAction(frame: { type: string } & Record<string, unknown>): Promise<ActionExecutionResult> {
		if (!this.connection?.connected) {
			return { result: ActionExecutionResultCode.Error, response: { key: 'Open Live is not connected' } }
		}
		try {
			await this.connection.send(frame).executed
			return { result: ActionExecutionResultCode.Ok }
		} catch (e) {
			return {
				result: ActionExecutionResultCode.Error,
				response: { key: 'Open Live: {{message}}', args: { message: (e as Error).message } },
			}
		}
	}
}
