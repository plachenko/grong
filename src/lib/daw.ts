import type { Instrument, Note } from './synth.js';

export const PIXELS_PER_SECOND = 80;
export const SNAP_SECONDS = 0.125;

export type ClipDraft = {
	name: string;
	blob: Blob;
	loop?: boolean;
	instrument?: Instrument;
	notes?: Note[];
	bpm?: number;
};

export type Clip = {
	id: number;
	name: string;
	url: string;
	start: number;
	duration: number;
	patternDuration: number;
	loop: boolean;
	instrument?: Instrument;
	notes?: Note[];
	waveform?: number[];
};

export type Track = {
	id: number;
	name: string;
	volume: number;
	muted: boolean;
	solo: boolean;
	clips: Clip[];
};

export function timelineLength(tracks: Track[]) {
	const end = Math.max(
		8,
		...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration))
	);
	return Math.ceil(end + 2);
}
