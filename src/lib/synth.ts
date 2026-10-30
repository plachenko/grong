export type Instrument = 'piano' | 'drums';
export type PitchPoint = { time: number; pitch: number };
export type Note = { pitch: number; start: number; duration?: number; bends?: PitchPoint[] };
export type ADSR = { attack: number; decay: number; sustain: number; release: number };
export const DEFAULT_ADSR: ADSR = { attack: 0.02, decay: 0.15, sustain: 0.6, release: 0.25 };
export const SCALE_INTERVALS = {
	chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
	major: [0, 2, 4, 5, 7, 9, 11],
	minor: [0, 2, 3, 5, 7, 8, 10],
	pentatonic: [0, 2, 4, 7, 9]
} as const;
export type Scale = keyof typeof SCALE_INTERVALS;

export function snapPitchToScale(pitch: number, root: number, scale: Scale) {
	const allowed = SCALE_INTERVALS[scale];
	let closest = Math.round(pitch);
	let distance = Infinity;
	for (let candidate = Math.floor(pitch) - 12; candidate <= Math.ceil(pitch) + 12; candidate++) {
		const interval = (((candidate - root) % 12) + 12) % 12;
		if (!allowed.some((value) => value === interval)) continue;
		const nextDistance = Math.abs(candidate - pitch);
		if (nextDistance < distance) {
			closest = candidate;
			distance = nextDistance;
		}
	}
	return closest;
}

export function pitchFrequency(pitch: number) {
	return 440 * 2 ** ((pitch - 69) / 12);
}

export const BEATS = 4;
export const STEPS = 16;
export const labels: Record<Instrument, { name: string; pitch: number }[]> = {
	piano: [
		{ name: 'C5', pitch: 72 },
		{ name: 'B4', pitch: 71 },
		{ name: 'A#4', pitch: 70 },
		{ name: 'A4', pitch: 69 },
		{ name: 'G#4', pitch: 68 },
		{ name: 'G4', pitch: 67 },
		{ name: 'F#4', pitch: 66 },
		{ name: 'F4', pitch: 65 },
		{ name: 'E4', pitch: 64 },
		{ name: 'D#4', pitch: 63 },
		{ name: 'D4', pitch: 62 },
		{ name: 'C#4', pitch: 61 },
		{ name: 'C4', pitch: 60 }
	],
	drums: [
		{ name: 'Hi-hat', pitch: 42 },
		{ name: 'Snare', pitch: 38 },
		{ name: 'Kick', pitch: 36 }
	]
};

export function barLength(bpm: number) {
	return (60 / bpm) * BEATS;
}

export function startPianoVoice(
	context: BaseAudioContext,
	pitch: number,
	when: number,
	envelope: ADSR = DEFAULT_ADSR
) {
	const peak = 0.3;
	const attack = Math.max(0.005, envelope.attack);
	const decay = Math.max(0.005, envelope.decay);
	const sustain = Math.min(1, Math.max(0, envelope.sustain));
	const release = Math.max(0.005, envelope.release);
	const gain = context.createGain();
	gain.connect(context.destination);
	const oscillator = context.createOscillator();
	oscillator.type = 'triangle';
	oscillator.frequency.value = pitchFrequency(pitch);
	oscillator.connect(gain);
	gain.gain.setValueAtTime(0, when);
	gain.gain.linearRampToValueAtTime(peak, when + attack);
	gain.gain.linearRampToValueAtTime(peak * sustain, when + attack + decay);
	oscillator.start(when);
	let released = false;
	return {
		bend(pitch: number, at: number, smooth = true) {
			if (released) return;
			const time = Math.max(when, at);
			const frequency = pitchFrequency(pitch);
			if (smooth) oscillator.frequency.setTargetAtTime(frequency, time, 0.008);
			else oscillator.frequency.linearRampToValueAtTime(frequency, time);
		},
		release(at: number) {
			if (released) return;
			released = true;
			const off = Math.max(when, at);
			const elapsed = off - when;
			const level =
				elapsed < attack
					? (peak * elapsed) / attack
					: elapsed < attack + decay
						? peak + ((peak * sustain - peak) * (elapsed - attack)) / decay
						: peak * sustain;
			if (typeof gain.gain.cancelAndHoldAtTime === 'function') {
				gain.gain.cancelAndHoldAtTime(off);
			} else {
				gain.gain.cancelScheduledValues(off);
				gain.gain.setValueAtTime(level, off);
			}
			gain.gain.linearRampToValueAtTime(0, off + release);
			oscillator.stop(off + release + 0.005);
		}
	};
}

export function playNote(
	context: BaseAudioContext,
	kind: Instrument,
	pitch: number,
	when: number,
	length: number,
	envelope: ADSR = DEFAULT_ADSR
) {
	if (kind === 'piano') {
		startPianoVoice(context, pitch, when, envelope).release(when + length);
		return;
	}
	const gain = context.createGain();
	gain.connect(context.destination);
	const end = when + length;
	if (pitch === 36) {
		const oscillator = context.createOscillator();
		oscillator.type = 'sine';
		oscillator.frequency.setValueAtTime(150, when);
		oscillator.frequency.exponentialRampToValueAtTime(45, end);
		oscillator.connect(gain);
		gain.gain.setValueAtTime(0.8, when);
		gain.gain.exponentialRampToValueAtTime(0.0001, end);
		oscillator.start(when);
		oscillator.stop(end);
		return;
	}

	const buffer = context.createBuffer(
		1,
		Math.ceil(length * context.sampleRate),
		context.sampleRate
	);
	const samples = buffer.getChannelData(0);
	for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
	const noise = context.createBufferSource();
	noise.buffer = buffer;
	const filter = context.createBiquadFilter();
	filter.type = pitch === 42 ? 'highpass' : 'bandpass';
	filter.frequency.value = pitch === 42 ? 7000 : 1800;
	noise.connect(filter);
	filter.connect(gain);
	gain.gain.setValueAtTime(pitch === 42 ? 0.18 : 0.5, when);
	gain.gain.exponentialRampToValueAtTime(0.0001, end);
	noise.start(when);
	noise.stop(end);
}

export function schedule(
	context: BaseAudioContext,
	kind: Instrument,
	notes: Note[],
	bpm: number,
	start: number,
	loop = false,
	envelope: ADSR = DEFAULT_ADSR
) {
	const beat = 60 / bpm;
	for (const note of notes) {
		const naturalLength =
			kind === 'piano' ? (note.duration ?? beat / 2) : note.pitch === 42 ? 0.08 : 0.2;
		const available = barLength(bpm) - note.start - 0.005;
		const release =
			loop && kind === 'piano'
				? Math.min(envelope.release, Math.max(0.005, available - 0.005))
				: envelope.release;
		const length = loop
			? Math.max(0.005, Math.min(naturalLength, available - (kind === 'piano' ? release : 0)))
			: naturalLength;
		const when = start + note.start;
		if (kind === 'piano') {
			const voice = startPianoVoice(context, note.pitch, when, { ...envelope, release });
			for (const point of note.bends ?? []) {
				if (point.time <= 0 || point.time >= length) continue;
				voice.bend(point.pitch, when + point.time, false);
			}
			voice.release(when + length);
		} else {
			playNote(context, kind, note.pitch, when, length, envelope);
		}
	}
}

export async function renderTrack(
	kind: Instrument,
	notes: Note[],
	bpm: number,
	loop = false,
	envelope: ADSR = DEFAULT_ADSR
): Promise<Blob> {
	const seconds = loop
		? barLength(bpm)
		: Math.max(
				barLength(bpm) + 0.25,
				...notes.map(
					(note) =>
						note.start +
						(note.duration ?? (kind === 'piano' ? 30 / bpm : 0.2)) +
						(kind === 'piano' ? envelope.release : 0) +
						0.05
				)
			);
	const sampleRate = 44100;
	const context = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
	schedule(context, kind, notes, bpm, 0, loop, envelope);
	const rendered = await context.startRendering();
	const samples = rendered.getChannelData(0);
	const bytes = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(bytes);
	const write = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};
	write(0, 'RIFF');
	view.setUint32(4, bytes.byteLength - 8, true);
	write(8, 'WAVE');
	write(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	write(36, 'data');
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const value = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
	}
	return new Blob([bytes], { type: 'audio/wav' });
}
