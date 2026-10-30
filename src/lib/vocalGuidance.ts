import { barLength, type Instrument, type Note } from './synth.js';

function downsample(samples: Float32Array, sampleRate: number) {
	const stride = Math.max(1, Math.round(sampleRate / 11025));
	const reduced = new Float32Array(Math.ceil(samples.length / stride));
	for (let i = 0; i < reduced.length; i++) {
		let sum = 0;
		let count = 0;
		for (let j = i * stride; j < Math.min(samples.length, (i + 1) * stride); j++) {
			sum += samples[j];
			count++;
		}
		reduced[i] = sum / count;
	}
	return { samples: reduced, sampleRate: sampleRate / stride };
}

function pitchAt(samples: Float32Array, offset: number, sampleRate: number) {
	const size = 512;
	const minLag = Math.floor(sampleRate / 800);
	const maxLag = Math.min(Math.ceil(sampleRate / 90), size - 1);
	const scores = new Float32Array(maxLag + 1);
	let running = 0;
	for (let lag = 1; lag <= maxLag; lag++) {
		let difference = 0;
		for (let i = 0; i < size; i++) {
			const delta = samples[offset + i] - samples[offset + i + lag];
			difference += delta * delta;
		}
		running += difference;
		scores[lag] = (difference * lag) / Math.max(running, 1e-10);
	}
	let bestLag = 0;
	let bestScore = 1;
	for (let lag = minLag; lag < maxLag; lag++) {
		const score = scores[lag];
		if (score < bestScore) {
			bestScore = score;
			bestLag = lag;
		}
		if (score < 0.16 && score <= scores[lag - 1] && score <= scores[lag + 1]) {
			bestLag = lag;
			bestScore = score;
			break;
		}
	}
	if (!bestLag || bestScore > 0.2) return null;
	const frequency = sampleRate / bestLag;
	const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
	if (!Number.isFinite(midi)) return null;
	let pitch = midi;
	while (pitch < 60) pitch += 12;
	while (pitch > 72) pitch -= 12;
	return pitch;
}

function pianoNotes(samples: Float32Array, sampleRate: number, duration: number): Note[] {
	const windowLength = Math.min(1024, samples.length);
	if (windowLength < 640) return [];
	const hop = Math.max(1, Math.round(sampleRate * 0.025));
	const frames: { time: number; rms: number; pitch: number | null }[] = [];
	let peak = 0;
	for (let offset = 0; offset + windowLength <= samples.length; offset += hop) {
		const slice = samples.subarray(offset, offset + windowLength);
		let sum = 0;
		for (const sample of slice) sum += sample * sample;
		const rms = Math.sqrt(sum / slice.length);
		peak = Math.max(peak, rms);
		frames.push({
			time: offset / sampleRate,
			rms,
			pitch: pitchAt(samples, offset, sampleRate)
		});
	}
	const threshold = Math.max(0.003, peak * 0.18);
	const pitches = frames.map((frame) => (frame.rms >= threshold ? frame.pitch : null));
	for (let i = 1; i < pitches.length - 1; i++) {
		if (pitches[i - 1] === pitches[i + 1]) pitches[i] = pitches[i - 1];
	}
	const notes: Note[] = [];
	for (let i = 0; i < pitches.length;) {
		const pitch = pitches[i];
		let end = i + 1;
		while (end < pitches.length && pitches[end] === pitch) end++;
		if (pitch !== null && end - i >= 3 && frames[i].time < duration) {
			notes.push({ pitch, start: frames[i].time });
		}
		i = end;
	}
	return notes;
}

function classifyHit(samples: Float32Array, start: number, sampleRate: number) {
	const end = Math.min(samples.length, start + Math.round(sampleRate * 0.04));
	let low = 0;
	let lowEnergy = 0;
	let total = 0;
	let highEnergy = 0;
	let previous = 0;
	for (let i = start; i < end; i++) {
		const sample = samples[i];
		low = low * 0.85 + sample * 0.15;
		lowEnergy += low * low;
		total += sample * sample;
		const change = (sample - previous) / 2;
		highEnergy += change * change;
		previous = sample;
	}
	if (total === 0) return 38;
	if (lowEnergy / total > 0.3) return 36;
	if (highEnergy / total > 0.35) return 42;
	return 38;
}

function drumNotes(samples: Float32Array, sampleRate: number, duration: number): Note[] {
	const frameLength = Math.max(1, Math.round(sampleRate * 0.01));
	const energies: number[] = [];
	let peak = 0;
	for (let offset = 0; offset < samples.length; offset += frameLength) {
		let sum = 0;
		const end = Math.min(samples.length, offset + frameLength);
		for (let i = offset; i < end; i++) sum += samples[i] * samples[i];
		const rms = Math.sqrt(sum / (end - offset));
		energies.push(rms);
		peak = Math.max(peak, rms);
	}
	const notes: Note[] = [];
	let lastHit = -1;
	for (let i = 1; i < energies.length; i++) {
		const time = (i * frameLength) / sampleRate;
		if (time >= duration) break;
		const level = energies[i];
		const previous = energies[i - 1];
		if (
			time - lastHit >= 0.09 &&
			level > Math.max(0.003, peak * 0.12) &&
			level - previous > Math.max(0.001, peak * 0.04) &&
			level > previous * 1.45
		) {
			notes.push({
				pitch: classifyHit(samples, i * frameLength, sampleRate),
				start: time
			});
			lastHit = time;
		}
	}
	return notes;
}

export function analyzeVoice(
	input: Float32Array,
	inputRate: number,
	kind: Instrument,
	bpm: number
): Note[] {
	const { samples, sampleRate } = downsample(input, inputRate);
	const duration = Math.min(samples.length / sampleRate, barLength(bpm));
	return kind === 'piano'
		? pianoNotes(samples, sampleRate, duration)
		: drumNotes(samples, sampleRate, duration);
}
