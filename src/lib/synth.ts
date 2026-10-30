export type Instrument = 'piano' | 'drums';
export type Note = { pitch: number; start: number };

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

export function playNote(
	context: BaseAudioContext,
	kind: Instrument,
	pitch: number,
	when: number,
	length: number
) {
	const gain = context.createGain();
	gain.connect(context.destination);
	const end = when + length;
	if (kind === 'piano') {
		const oscillator = context.createOscillator();
		oscillator.type = 'triangle';
		oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
		oscillator.connect(gain);
		gain.gain.setValueAtTime(0.0001, when);
		gain.gain.exponentialRampToValueAtTime(0.3, when + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, end);
		oscillator.start(when);
		oscillator.stop(end);
		return;
	}

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
	loop = false
) {
	const beat = 60 / bpm;
	for (const note of notes) {
		const naturalLength = kind === 'piano' ? beat / 2 : note.pitch === 42 ? 0.08 : 0.2;
		const length = loop
			? Math.max(0.015, Math.min(naturalLength, barLength(bpm) - note.start - 0.005))
			: naturalLength;
		playNote(context, kind, note.pitch, start + note.start, length);
	}
}

export async function renderTrack(
	kind: Instrument,
	notes: Note[],
	bpm: number,
	loop = false
): Promise<Blob> {
	const seconds = barLength(bpm) + (loop ? 0 : 0.25);
	const sampleRate = 44100;
	const context = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
	schedule(context, kind, notes, bpm, 0, loop);
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
