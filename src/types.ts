/**
 * Public types for the Open Live TSR plugin.
 *
 * Blueprints import these (via a `tsr-types.d.ts` module augmentation of
 * `TimelineContentMap`) so Sofie timeline objects can target Open Live.
 */

import type { DeviceOptionsBase } from 'timeline-state-resolver-types'

export const OpenLiveDeviceType = 'OPEN_LIVE' as const
export type OpenLiveDeviceType = typeof OpenLiveDeviceType

// ---------------------------------------------------------------------------
// Device options (configured per device in Sofie: Settings → Studio → Devices)
// ---------------------------------------------------------------------------

export type OpenLiveAuthMode = 'none' | 'apiKey' | 'osc'

export interface OpenLiveOptions {
	/** Base URL of the Open Live backend, e.g. https://<tenant>-<name>.eyevinn-open-live.auto.prod-se.osaas.io */
	url: string
	/** The Open Live production to drive */
	productionId: string
	/** How to authenticate the controller WebSocket */
	authMode?: OpenLiveAuthMode
	/** Open Live API_KEY (authMode = apiKey). Prefer OPEN_LIVE_API_KEY on the gateway */
	apiKey?: string
	/** OSC Personal Access Token, exchanged for a short-lived SAT (authMode = osc). Prefer OPEN_LIVE_OSC_PAT on the gateway */
	oscPat?: string
	/** OSC serviceId the SAT is scoped to. Default eyevinn-open-live */
	oscServiceId?: string
	/** How long to wait for an ACK executed/NACK before flagging a command as slow. Default 5000 */
	ackTimeoutMs?: number
	/** Interval for KEEP_ALIVE frames that hold off the idle watchdog. 0 disables. Default 30000 */
	keepAliveIntervalMs?: number
}

// ---------------------------------------------------------------------------
// Mappings (one per Sofie layer)
// ---------------------------------------------------------------------------

export enum MappingOpenLiveType {
	Program = 'program',
	Preview = 'preview',
	Dsk = 'dsk',
	Graphic = 'graphic',
	Audio = 'audio',
	Clip = 'clip',
	OnAir = 'onAir',
	Ftb = 'ftb',
}

export interface MappingOpenLiveProgram {
	mappingType: MappingOpenLiveType.Program
}
export interface MappingOpenLivePreview {
	mappingType: MappingOpenLiveType.Preview
}
export interface MappingOpenLiveDsk {
	mappingType: MappingOpenLiveType.Dsk
	/** DSK layer index */
	layer: number
}
export interface MappingOpenLiveGraphic {
	mappingType: MappingOpenLiveType.Graphic
	/** Graphics overlay id */
	overlayId: string
}
export interface MappingOpenLiveAudio {
	mappingType: MappingOpenLiveType.Audio
	/** Mixer element id: `main`, `ch{N}`, ... */
	elementId: string
}
export interface MappingOpenLiveClip {
	mappingType: MappingOpenLiveType.Clip
	/** Mixer input the clip player is assigned to */
	mixerInput: string
}
export interface MappingOpenLiveOnAir {
	mappingType: MappingOpenLiveType.OnAir
}
export interface MappingOpenLiveFtb {
	mappingType: MappingOpenLiveType.Ftb
}

export type SomeMappingOpenLive =
	| MappingOpenLiveProgram
	| MappingOpenLivePreview
	| MappingOpenLiveDsk
	| MappingOpenLiveGraphic
	| MappingOpenLiveAudio
	| MappingOpenLiveClip
	| MappingOpenLiveOnAir
	| MappingOpenLiveFtb

// ---------------------------------------------------------------------------
// Timeline content
// ---------------------------------------------------------------------------

export enum TimelineContentTypeOpenLive {
	Program = 'program',
	Preview = 'preview',
	Dsk = 'dsk',
	Graphic = 'graphic',
	Audio = 'audio',
	Clip = 'clip',
	OnAir = 'onAir',
	Ftb = 'ftb',
}

interface TimelineContentOpenLiveBase {
	deviceType: OpenLiveDeviceType
	type: TimelineContentTypeOpenLive
}

export interface OpenLiveTransition {
	/** Open Live transition type, e.g. `fade`, `wipe_left`. Omit or `cut` for a hard cut */
	type: string
	durationMs?: number
}

/** Puts `input` on program. Changing input on this layer cuts or transitions. */
export interface TimelineContentOpenLiveProgram extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.Program
	/** Mixer input pad, e.g. `video_in_2` */
	input: string
	/** How to bring this input to program. Default: cut */
	transition?: OpenLiveTransition
	/** Audio-follows-video ramp overrides */
	afvRampUpMs?: number
	afvRampDownMs?: number
}

/** Puts `input` on preview (typically emitted by Sofie lookahead). */
export interface TimelineContentOpenLivePreview extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.Preview
	input: string
}

/** A DSK layer is visible while an object is active on its layer. */
export interface TimelineContentOpenLiveDsk extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.Dsk
}

/** A graphics overlay is shown while an object is active on its layer. */
export interface TimelineContentOpenLiveGraphic extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.Graphic
}

/** Sets fader/mute. No object = the device leaves the channel as it is. */
export interface TimelineContentOpenLiveAudio extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.Audio
	/** Linear fader value as used by Open Live AUDIO_SET */
	volume?: number
	muted?: boolean
	rampMs?: number
}

/** Plays the clip on the mapped clip input while active; stops it when the object ends. */
export interface TimelineContentOpenLiveClip extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.Clip
	/** Clip id to cue. Omit to use the clip already assigned to the input */
	clipId?: string
	/** false = cue and hold paused. Default true */
	playing?: boolean
}

/** Explicit on-air state. No object = the device leaves on-air state as it is. */
export interface TimelineContentOpenLiveOnAir extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.OnAir
	onAir: boolean
}

/** Fade to black while active. */
export interface TimelineContentOpenLiveFtb extends TimelineContentOpenLiveBase {
	type: TimelineContentTypeOpenLive.Ftb
	durationMs?: number
}

export type TimelineContentOpenLiveAny =
	| TimelineContentOpenLiveProgram
	| TimelineContentOpenLivePreview
	| TimelineContentOpenLiveDsk
	| TimelineContentOpenLiveGraphic
	| TimelineContentOpenLiveAudio
	| TimelineContentOpenLiveClip
	| TimelineContentOpenLiveOnAir
	| TimelineContentOpenLiveFtb

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export enum OpenLiveActions {
	Resync = 'resync',
	RunMacro = 'runMacro',
}

// Register the device with TSR's type system so timeline objects and mappings
// accept `deviceType: 'OPEN_LIVE'`. Blueprints get this by importing this package.
declare module 'timeline-state-resolver-types' {
	interface TimelineContentMap {
		[OpenLiveDeviceType]: TimelineContentOpenLiveAny
	}
	interface DeviceOptionsMap {
		[OpenLiveDeviceType]: DeviceOptionsBase<OpenLiveDeviceType, OpenLiveOptions>
	}
	interface TSRDeviceTypesMap {
		[OpenLiveDeviceType]: {
			Type: OpenLiveDeviceType
			Options: OpenLiveOptions
			Mappings: SomeMappingOpenLive
			Actions: Record<OpenLiveActions, (payload: any) => Promise<any>>
		}
	}
}
