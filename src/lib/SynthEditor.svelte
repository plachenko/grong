<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import PianoKeyboard from '#lib/PianoKeyboard.svelte';
	import type { ClipDraft } from '#lib/daw.js';
	import {
		BEATS,
		STEPS,
		barLength,
		labels,
		playNote,
		snapPitchToScale,
		startPianoVoice,
		renderTrack,
		schedule,
		type Instrument,
		type Note,
		type Scale
	} from '#lib/synth.js';
	import { analyzeVoice, calibrateVoice, type VoiceCalibration } from '#lib/vocalGuidance.js';

	let {
		kind,
		onSave,
		calibration,
		onCalibrate
	}: {
		kind: Instrument;
		onSave: (clip: ClipDraft) => Promise<void>;
		calibration?: VoiceCalibration;
		onCalibrate: (kind: Instrument, result: VoiceCalibration) => void;
	} = $props();

	let bpm = $state(120);
	let attack = $state(0.02);
	let decay = $state(0.15);
	let sustain = $state(0.6);
	let release = $state(0.25);
	let snapEnabled = $state(false);
	let scaleRoot = $state(0);
	let scale = $state<Scale>('major');
	let activePitch = $state<number | null>(null);
	let livePitches = $state<number[]>([]);
	let tappedPitches = $state<number[]>([]);
	let previewPitches = $state<number[]>([]);
	let notes = $state<Note[]>([]);
	let recording = $state(false);
	let previewing = $state(false);
	let saving = $state(false);
	let loopEnabled = $state(false);
	let vocalRecording = $state(false);
	let vocalStarting = $state(false);
	let vocalProcessing = $state(false);
	let calibrationStarting = $state(false);
	let calibrating = $state(false);
	let calibrationProcessing = $state(false);
	let calibrationPhase = $state<'quiet' | 'sample' | null>(null);
	let message = $state('');
	let context: AudioContext | undefined;
	let previewContext: AudioContext | undefined;
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	let previewFrame: number | undefined;
	const tapTimers = new SvelteSet<ReturnType<typeof setTimeout>>();
	const tapCounts = new SvelteMap<number, number>();
	let recordTimer: ReturnType<typeof setTimeout> | undefined;
	let recordStart = 0;
	let takeNumber = 1;
	let recorder: MediaRecorder | undefined;
	let microphone: MediaStream | undefined;
	let vocalTimer: ReturnType<typeof setTimeout> | undefined;
	let calibrationRecorder: MediaRecorder | undefined;
	let calibrationStream: MediaStream | undefined;
	let calibrationQuietTimer: ReturnType<typeof setTimeout> | undefined;
	let calibrationStopTimer: ReturnType<typeof setTimeout> | undefined;
	let calibrationCancelled = false;
	let disposed = false;
	type ActiveVoice = {
		release: (at: number) => void;
		bend: (pitch: number, at: number) => void;
		startedAt: number;
		noteIndex: number | null;
		basePitch: number;
		pitch: number;
	};
	const activeVoices: Record<number, ActiveVoice> = {};

	const columns = Array.from({ length: STEPS }, (_, index) => index);
	const blackPitches = new Set([1, 3, 6, 8, 10]);
	const isBlackKey = (pitch: number) => blackPitches.has(pitch % 12);
	const pitchNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
	const scaleRoots = pitchNames.map((name, value) => ({ name, value }));
	function pitchLabel(pitch: number) {
		const nearest = Math.round(pitch);
		const name = pitchNames[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1);
		const cents = Math.round((pitch - nearest) * 100);
		return name + (cents ? ' ' + (cents > 0 ? '+' : '') + cents + '¢' : '');
	}
	let tempo = $derived(Math.min(240, Math.max(40, Number(bpm) || 120)));
	let stepLength = $derived((60 / tempo) * (BEATS / STEPS));
	let envelope = $derived({ attack, decay, sustain, release });
	let calibrationBusy = $derived(calibrationStarting || calibrating || calibrationProcessing);
	let playingPitches = $derived([
		...new Set([...livePitches, ...tappedPitches, ...previewPitches])
	]);

	function refreshLivePitches() {
		livePitches = Object.values(activeVoices).map((voice) => Math.round(voice.pitch));
	}

	function markTap(pitch: number, length: number) {
		const key = Math.round(pitch);
		tapCounts.set(key, (tapCounts.get(key) ?? 0) + 1);
		tappedPitches = [...tapCounts.keys()];
		const timer = setTimeout(() => {
			tapTimers.delete(timer);
			const remaining = (tapCounts.get(key) ?? 1) - 1;
			if (remaining) tapCounts.set(key, remaining);
			else tapCounts.delete(key);
			tappedPitches = [...tapCounts.keys()];
		}, length * 1000);
		tapTimers.add(timer);
	}

	function pitchDuringNote(note: Note, elapsed: number) {
		let previousTime = 0;
		let previousPitch = note.pitch;
		for (const bend of note.bends ?? []) {
			if (elapsed < bend.time) {
				const fraction = (elapsed - previousTime) / (bend.time - previousTime);
				return previousPitch + (bend.pitch - previousPitch) * fraction;
			}
			previousTime = bend.time;
			previousPitch = bend.pitch;
		}
		return previousPitch;
	}

	async function tap(pitch: number) {
		if (calibrationBusy) return;
		if (recording) {
			const start = (performance.now() - recordStart) / 1000;
			if (start < barLength(tempo))
				notes = [...notes, { pitch, start, ...(kind === 'piano' ? { duration: 0.25 } : {}) }];
		}
		try {
			context ??= new AudioContext();
			await context.resume();
			playNote(
				context,
				kind,
				pitch,
				context.currentTime + 0.01,
				kind === 'piano' ? 0.25 : 0.18,
				envelope
			);
			markTap(pitch, kind === 'piano' ? 0.25 : 0.18);
		} catch {
			message = 'Audio playback is unavailable in this browser.';
		}
	}

	function pressPiano(pitch: number, pointerId: number) {
		if (calibrationBusy) return;
		if (activeVoices[pointerId]) return;
		const initialPitch = snapEnabled ? snapPitchToScale(pitch, scaleRoot, scale) : pitch;
		const startedAt = performance.now();
		let noteIndex: number | null = null;
		if (recording) {
			const start = (startedAt - recordStart) / 1000;
			if (start < barLength(tempo)) {
				noteIndex = notes.length;
				notes = [...notes, { pitch: initialPitch, start, duration: 0.05 }];
			}
		}
		let releaseVoice: (at: number) => void = () => {};
		let bendVoice: (pitch: number, at: number) => void = () => {};
		try {
			context ??= new AudioContext();
			void context.resume().catch(() => {
				message = 'Audio playback is unavailable in this browser.';
			});
			const voice = startPianoVoice(context, initialPitch, context.currentTime + 0.01, envelope);
			releaseVoice = voice.release;
			bendVoice = voice.bend;
		} catch {
			message = 'Audio playback is unavailable in this browser.';
		}
		activeVoices[pointerId] = {
			release: releaseVoice,
			bend: bendVoice,
			startedAt,
			noteIndex,
			basePitch: pitch,
			pitch: initialPitch
		};
		activePitch = initialPitch;
		refreshLivePitches();
	}

	function bendPiano(pointerId: number, semitones: number) {
		const active = activeVoices[pointerId];
		if (!active) return;
		const freePitch = active.basePitch + Math.max(-2, Math.min(2, semitones));
		const pitch = snapEnabled ? snapPitchToScale(freePitch, scaleRoot, scale) : freePitch;
		if (Math.abs(pitch - active.pitch) < 0.015) return;
		active.pitch = pitch;
		activePitch = pitch;
		refreshLivePitches();
		active.bend(pitch, context?.currentTime ?? 0);
		if (active.noteIndex !== null) {
			const index = active.noteIndex;
			const note = notes[index];
			if (!note) return;
			const time = Math.min(
				(performance.now() - active.startedAt) / 1000,
				barLength(tempo) - note.start
			);
			if (time <= 0) return;
			notes = notes.map((item, itemIndex) =>
				itemIndex === index ? { ...item, bends: [...(item.bends ?? []), { time, pitch }] } : item
			);
		}
	}

	function releasePiano(pointerId: number) {
		const active = activeVoices[pointerId];
		if (!active) return;
		delete activeVoices[pointerId];
		activePitch = Object.values(activeVoices).at(-1)?.pitch ?? null;
		refreshLivePitches();
		active.release(context?.currentTime ?? 0);
		if (active.noteIndex !== null) {
			const index = active.noteIndex;
			const note = notes[index];
			if (!note) return;
			const duration = Math.max(
				0.05,
				Math.min((performance.now() - active.startedAt) / 1000, barLength(tempo) - note.start)
			);
			notes = notes.map((item, itemIndex) => (itemIndex === index ? { ...item, duration } : item));
		}
	}

	function releaseAllPiano() {
		for (const pointerId of Object.keys(activeVoices)) releasePiano(Number(pointerId));
	}

	function toggleCell(pitch: number, step: number) {
		stopPreview();
		const found = notes.findIndex(
			(note) =>
				note.pitch === pitch && Math.min(STEPS - 1, Math.round(note.start / stepLength)) === step
		);
		if (found >= 0) {
			notes = notes.filter((_, index) => index !== found);
		} else {
			notes = [...notes, { pitch, start: step * stepLength }];
		}
		message = '';
	}

	function hasNote(pitch: number, step: number) {
		return notes.some(
			(note) =>
				note.pitch === pitch && Math.min(STEPS - 1, Math.round(note.start / stepLength)) === step
		);
	}

	function stopRecording() {
		releaseAllPiano();
		if (recordTimer) clearTimeout(recordTimer);
		recordTimer = undefined;
		recording = false;
		message = notes.length
			? 'Take captured. Quantize or save it as a track.'
			: 'No notes captured.';
	}

	function toggleRecording() {
		if (calibrationBusy) return;
		if (recording) {
			stopRecording();
			return;
		}
		stopPreview();
		releaseAllPiano();
		notes = [];
		recording = true;
		recordStart = performance.now();
		message = 'Tap the instrument keys. Recording lasts one bar.';
		recordTimer = setTimeout(stopRecording, barLength(tempo) * 1000);
	}

	function stopVocal() {
		if (vocalTimer) clearTimeout(vocalTimer);
		vocalTimer = undefined;
		if (recorder?.state === 'recording') recorder.stop();
	}

	function stopCalibration(cancel = false) {
		if (cancel) calibrationCancelled = true;
		if (calibrationQuietTimer) clearTimeout(calibrationQuietTimer);
		if (calibrationStopTimer) clearTimeout(calibrationStopTimer);
		calibrationQuietTimer = undefined;
		calibrationStopTimer = undefined;
		if (calibrationRecorder?.state === 'recording') calibrationRecorder.stop();
		if (cancel) {
			calibrating = false;
			calibrationProcessing = true;
			calibrationPhase = null;
			message = 'Voice calibration cancelled.';
		}
	}

	async function toggleCalibration() {
		if (calibrating) {
			stopCalibration(true);
			return;
		}
		if (
			calibrationStarting ||
			calibrationProcessing ||
			vocalRecording ||
			vocalStarting ||
			vocalProcessing
		)
			return;
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			message = 'Microphone calibration requires HTTPS or localhost in a supported browser.';
			return;
		}
		stopPreview();
		releaseAllPiano();
		calibrationStarting = true;
		calibrationCancelled = false;
		message = 'Allow microphone access to calibrate vocal guidance.';
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
			});
			if (disposed) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			calibrationStream = stream;
			const chunks: Blob[] = [];
			const mediaRecorder = new MediaRecorder(stream);
			calibrationRecorder = mediaRecorder;
			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			mediaRecorder.onstop = async () => {
				for (const track of stream.getTracks()) track.stop();
				calibrationStream = undefined;
				calibrationRecorder = undefined;
				calibrating = false;
				calibrationPhase = null;
				if (disposed || calibrationCancelled) {
					calibrationProcessing = false;
					return;
				}
				calibrationProcessing = true;
				message = 'Measuring microphone levels…';
				let decoder: AudioContext | undefined;
				try {
					if (!chunks.length) throw new Error('Empty calibration');
					decoder = new AudioContext();
					const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
					const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
					if (disposed) return;
					const result = calibrateVoice(buffer.getChannelData(0), buffer.sampleRate);
					if (!result) {
						message =
							'Calibration needs a clearer example. Stay quiet first, then make a louder sound.';
					} else {
						onCalibrate(kind, result);
						message =
							'Vocal guidance calibrated for this ' +
							(kind === 'piano' ? 'synth.' : 'drum machine.');
					}
				} catch {
					message = 'Could not read the calibration recording.';
				} finally {
					if (decoder) void decoder.close();
					calibrationProcessing = false;
				}
			};
			mediaRecorder.start();
			calibrating = true;
			calibrationPhase = 'quiet';
			message = 'Stay quiet for the first second.';
			calibrationQuietTimer = setTimeout(() => {
				calibrationPhase = 'sample';
				message = kind === 'piano' ? 'Hum a clear note now.' : 'Beatbox several hits now.';
			}, 900);
			calibrationStopTimer = setTimeout(() => stopCalibration(), 2700);
		} catch {
			if (calibrationStream) for (const track of calibrationStream.getTracks()) track.stop();
			calibrationStream = undefined;
			calibrationRecorder = undefined;
			calibrating = false;
			calibrationPhase = null;
			message = 'Microphone access was denied or calibration could not start.';
		} finally {
			calibrationStarting = false;
		}
	}

	async function toggleVocal() {
		if (vocalRecording) {
			stopVocal();
			return;
		}
		if (
			vocalStarting ||
			vocalProcessing ||
			calibrationStarting ||
			calibrating ||
			calibrationProcessing
		)
			return;
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			message =
				'Microphone recording is unavailable. Use HTTPS or localhost in a supported browser.';
			return;
		}
		stopPreview();
		vocalStarting = true;
		message = 'Allow microphone access to guide the instrument.';
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
			});
			if (disposed) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			microphone = stream;
			const chunks: Blob[] = [];
			const capturedTempo = tempo;
			const capturedKind = kind;
			const mediaRecorder = new MediaRecorder(stream);
			recorder = mediaRecorder;
			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			mediaRecorder.onstop = async () => {
				for (const track of stream.getTracks()) track.stop();
				microphone = undefined;
				vocalRecording = false;
				if (disposed) return;
				vocalProcessing = true;
				message = 'Converting your voice to notes…';
				let decoder: AudioContext | undefined;
				try {
					if (!chunks.length) throw new Error('Empty recording');
					decoder = new AudioContext();
					const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
					const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
					const channel = buffer.getChannelData(0);
					notes = analyzeVoice(
						channel,
						buffer.sampleRate,
						capturedKind,
						capturedTempo,
						calibration
					);
					message = notes.length
						? 'Vocal guidance added ' + notes.length + ' notes. Quantize, edit, preview, or save.'
						: 'No clear notes found. Try a louder hum or sharper beatbox hits.';
				} catch {
					message = 'Could not read the microphone recording.';
				} finally {
					if (decoder) void decoder.close();
					vocalProcessing = false;
				}
			};
			notes = [];
			mediaRecorder.start();
			vocalRecording = true;
			message = kind === 'piano' ? 'Hum a tune for one bar.' : 'Beatbox a rhythm for one bar.';
			vocalTimer = setTimeout(stopVocal, barLength(capturedTempo) * 1000);
		} catch {
			if (microphone) for (const track of microphone.getTracks()) track.stop();
			microphone = undefined;
			message = 'Microphone access was denied or recording could not start.';
		} finally {
			vocalStarting = false;
		}
	}

	function quantize() {
		stopPreview();
		notes = notes.map((note) => ({
			...note,
			start: Math.min(
				(STEPS - 1) * stepLength,
				Math.max(0, Math.round(note.start / stepLength) * stepLength)
			)
		}));
		message = 'Notes snapped to the nearest sixteenth note.';
	}

	function stopPreview() {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = undefined;
		if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
		previewFrame = undefined;
		previewPitches = [];
		if (previewContext) void previewContext.close();
		previewContext = undefined;
		previewing = false;
	}

	async function preview() {
		if (previewing) {
			stopPreview();
			return;
		}
		if (!notes.length) return;
		try {
			const activeContext = new AudioContext();
			previewContext = activeContext;
			await activeContext.resume();
			if (previewContext !== activeContext) {
				void activeContext.close();
				return;
			}
			const previewTempo = tempo;
			const previewNotes = notes.map((note) => ({ ...note }));
			const previewEnvelope = { ...envelope };
			const bar = barLength(previewTempo);
			let nextStart = activeContext.currentTime + 0.05;
			const firstStart = nextStart;
			const previewLoop = loopEnabled;
			const updateHighlights = () => {
				if (previewContext !== activeContext) return;
				const elapsed = activeContext.currentTime - firstStart;
				const position = previewLoop ? ((elapsed % bar) + bar) % bar : elapsed;
				const active =
					elapsed < 0
						? []
						: previewNotes.flatMap((note) => {
								const length =
									kind === 'piano'
										? (note.duration ?? 30 / previewTempo)
										: note.pitch === 42
											? 0.08
											: 0.2;
								const end = previewLoop ? Math.min(note.start + length, bar) : note.start + length;
								return position >= note.start && position < end
									? [Math.round(pitchDuringNote(note, position - note.start))]
									: [];
							});
				const next = [...new Set(active)];
				if (next.join(',') !== previewPitches.join(',')) previewPitches = next;
				previewFrame = requestAnimationFrame(updateHighlights);
			};
			previewing = true;
			previewFrame = requestAnimationFrame(updateHighlights);
			if (loopEnabled) {
				const queueBars = () => {
					if (previewContext !== activeContext) return;
					while (nextStart < activeContext.currentTime + bar * 1.5) {
						schedule(
							activeContext,
							kind,
							previewNotes,
							previewTempo,
							nextStart,
							true,
							previewEnvelope
						);
						nextStart += bar;
					}
					previewTimer = setTimeout(queueBars, Math.min(250, bar * 250));
				};
				queueBars();
			} else {
				schedule(
					activeContext,
					kind,
					previewNotes,
					previewTempo,
					nextStart,
					false,
					previewEnvelope
				);
				const end = Math.max(
					bar + 0.3,
					...previewNotes.map(
						(note) =>
							note.start +
							(note.duration ?? (kind === 'piano' ? 30 / previewTempo : 0.2)) +
							(kind === 'piano' ? previewEnvelope.release : 0)
					)
				);
				previewTimer = setTimeout(stopPreview, (end + 0.1) * 1000);
			}
		} catch {
			stopPreview();
			message = 'Audio playback is unavailable in this browser.';
		}
	}

	async function save() {
		if (!notes.length || saving) return;
		saving = true;
		try {
			const blob = await renderTrack(kind, notes, tempo, loopEnabled, envelope);
			const name = (kind === 'piano' ? 'Piano roll' : 'Drum machine') + ' take ' + takeNumber++;
			await onSave({
				name,
				blob,
				loop: loopEnabled,
				instrument: kind,
				notes: notes.map((note) => ({ ...note })),
				bpm: tempo
			});
			message = name + ' added to tracks.';
		} catch {
			message = 'Could not save this track.';
		} finally {
			saving = false;
		}
	}

	onDestroy(() => {
		disposed = true;
		for (const timer of tapTimers) clearTimeout(timer);
		tapTimers.clear();
		releaseAllPiano();
		if (vocalTimer) clearTimeout(vocalTimer);
		stopCalibration(true);
		if (recorder?.state === 'recording') recorder.stop();
		if (microphone) for (const track of microphone.getTracks()) track.stop();
		if (recordTimer) clearTimeout(recordTimer);
		stopPreview();
		if (context) void context.close();
	});
</script>

<section class="flex min-h-0 flex-1 flex-col overflow-hidden bg-red-200">
	<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
		<div class="flex flex-row flex-wrap items-start gap-4">
			<div class="min-w-[18rem] flex-1">
				<div class="mb-3 flex flex-wrap items-center gap-3">
					<h2 class="text-lg font-semibold">{kind === 'piano' ? 'Piano roll' : 'Drum machine'}</h2>
					<label class="flex items-center gap-2">
						BPM
						<input
							type="number"
							min="40"
							max="240"
							bind:value={bpm}
							disabled={recording ||
								previewing ||
								vocalRecording ||
								vocalStarting ||
								vocalProcessing ||
								calibrationBusy}
							class="w-18 rounded border bg-white px-1"
						/>
					</label>
					<button
						type="button"
						class="rounded border px-2 py-1"
						disabled={vocalRecording || vocalStarting || vocalProcessing || calibrationBusy}
						onclick={toggleRecording}
					>
						{recording ? 'Stop recording' : 'Record notes'}
					</button>
					<button
						type="button"
						class="rounded border px-2 py-1"
						disabled={recording || vocalStarting || vocalProcessing || calibrationBusy}
						onclick={toggleVocal}
					>
						{vocalRecording ? 'Stop vocal guidance' : 'Vocal guidance'}
					</button>
					<button
						type="button"
						class="rounded border px-2 py-1"
						disabled={recording ||
							vocalRecording ||
							vocalStarting ||
							vocalProcessing ||
							calibrationStarting ||
							calibrationProcessing}
						onclick={toggleCalibration}
					>
						{calibrating
							? 'Cancel calibration'
							: calibration
								? 'Recalibrate voice'
								: 'Calibrate voice'}
					</button>
					<span class="text-sm" role="status">
						{calibrationPhase === 'quiet'
							? 'Stay quiet…'
							: calibrationPhase === 'sample'
								? kind === 'piano'
									? 'Hum a clear note…'
									: 'Beatbox several hits…'
								: calibrationProcessing
									? 'Measuring…'
									: calibration
										? 'Voice calibrated'
										: 'Quiet first, then hum or beatbox to calibrate.'}
					</span>
					<button
						type="button"
						class="rounded border px-2 py-1"
						disabled={!notes.length ||
							recording ||
							vocalRecording ||
							vocalStarting ||
							vocalProcessing ||
							calibrationBusy}
						onclick={quantize}
					>
						Quantize
					</button>
					<label class="flex items-center gap-1">
						<input
							type="checkbox"
							bind:checked={loopEnabled}
							disabled={recording ||
								previewing ||
								vocalRecording ||
								vocalStarting ||
								vocalProcessing}
						/>
						Loop pattern
					</label>
					<button
						type="button"
						class="rounded border px-2 py-1"
						disabled={!notes.length ||
							recording ||
							vocalRecording ||
							vocalStarting ||
							vocalProcessing ||
							calibrationBusy}
						onclick={preview}
					>
						{previewing ? 'Stop preview' : 'Preview'}
					</button>
					<button
						type="button"
						class="rounded border px-2 py-1"
						disabled={!notes.length ||
							recording ||
							vocalRecording ||
							vocalStarting ||
							vocalProcessing ||
							saving}
						onclick={save}
					>
						{saving ? 'Rendering…' : 'Save as track'}
					</button>
					<button
						type="button"
						class="rounded border px-2 py-1"
						disabled={recording ||
							vocalRecording ||
							vocalStarting ||
							vocalProcessing ||
							!notes.length}
						onclick={() => {
							notes = [];
							message = '';
							stopPreview();
						}}
					>
						Clear
					</button>
				</div>
			</div>
			{#if kind === 'piano'}
				<div class="min-w-[18rem] flex-1">
					<div
						class="mb-3 flex flex-wrap items-center gap-3 rounded border border-red-400 p-3 text-sm"
					>
						<label class="flex items-center gap-2">
							<input type="checkbox" bind:checked={snapEnabled} />
							Snap pitch to scale
						</label>
						<label class="flex items-center gap-2">
							Key
							<select bind:value={scaleRoot} class="rounded border bg-white px-2 py-1">
								{#each scaleRoots as root (root.value)}
									<option value={root.value}>{root.name}</option>
								{/each}
							</select>
						</label>
						<label class="flex items-center gap-2">
							Scale
							<select bind:value={scale} class="rounded border bg-white px-2 py-1">
								<option value="major">Major</option>
								<option value="minor">Minor</option>
								<option value="pentatonic">Major pentatonic</option>
								<option value="chromatic">Chromatic</option>
							</select>
						</label>
						<span aria-live="off"
							>{activePitch === null
								? 'Slide a held key up or down to bend pitch (±2 semitones).'
								: 'Pitch: ' + pitchLabel(activePitch)}</span
						>
					</div>
					<fieldset class="mb-3 rounded border border-red-400 p-3">
						<legend class="px-1 font-medium">Envelope (ADSR)</legend>
						<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<label class="flex items-center gap-2 text-sm">
								Attack
								<input
									type="range"
									min="0"
									max="2"
									step="0.01"
									bind:value={attack}
									class="min-w-0 flex-1"
								/>
								<output class="w-10 text-right">{attack.toFixed(2)}s</output>
							</label>
							<label class="flex items-center gap-2 text-sm">
								Decay
								<input
									type="range"
									min="0"
									max="2"
									step="0.01"
									bind:value={decay}
									class="min-w-0 flex-1"
								/>
								<output class="w-10 text-right">{decay.toFixed(2)}s</output>
							</label>
							<label class="flex items-center gap-2 text-sm">
								Sustain
								<input
									type="range"
									min="0"
									max="1"
									step="0.01"
									bind:value={sustain}
									class="min-w-0 flex-1"
								/>
								<output class="w-10 text-right">{Math.round(sustain * 100)}%</output>
							</label>
							<label class="flex items-center gap-2 text-sm">
								Release
								<input
									type="range"
									min="0"
									max="3"
									step="0.01"
									bind:value={release}
									class="min-w-0 flex-1"
								/>
								<output class="w-10 text-right">{release.toFixed(2)}s</output>
							</label>
						</div>
					</fieldset>
				</div>
			{/if}
		</div>
		<p class="mb-2 text-sm">
			Tap the keys, use vocal guidance, or click cells to build a one-bar pattern. Each column is a
			sixteenth note.
		</p>
		{#if message}<p class="mt-2 text-sm" role="status">{message}</p>{/if}
	</div>
	<div class="flex min-h-[150px] flex-[2] flex-col gap-2 border-t border-red-400 p-2">
		{#if kind === 'drums'}
			<div class="flex shrink-0 flex-wrap gap-2">
				{#each labels[kind] as row (row.pitch)}
					<button
						type="button"
						class="rounded border-2 border-red-500 px-3 py-2"
						class:bg-white={!playingPitches.includes(row.pitch)}
						class:bg-amber-300={playingPitches.includes(row.pitch)}
						aria-pressed={playingPitches.includes(row.pitch)}
						onclick={() => tap(row.pitch)}
					>
						{row.name}
					</button>
				{/each}
			</div>
		{/if}
		<div class="min-h-0 flex-1 overflow-auto overscroll-contain">
			<div class="min-w-[640px]">
				<div class="grid grid-cols-[5rem_repeat(16,minmax(0,1fr))] gap-0.5 text-center text-xs">
					<span></span>
					{#each columns as step (step)}
						<span>{step + 1}</span>
					{/each}
					{#each labels[kind] as row (row.pitch)}
						{#if kind === 'piano'}
							<button
								type="button"
								class="h-7 rounded-r border border-slate-700 text-left text-xs"
								class:bg-slate-900={isBlackKey(row.pitch) && !playingPitches.includes(row.pitch)}
								class:text-white={isBlackKey(row.pitch)}
								class:bg-white={!isBlackKey(row.pitch) && !playingPitches.includes(row.pitch)}
								class:bg-amber-500={isBlackKey(row.pitch) && playingPitches.includes(row.pitch)}
								class:bg-amber-300={!isBlackKey(row.pitch) && playingPitches.includes(row.pitch)}
								class:pl-4={isBlackKey(row.pitch)}
								class:pl-2={!isBlackKey(row.pitch)}
								aria-label={'Play ' + row.name}
								aria-pressed={playingPitches.includes(row.pitch)}
								onclick={() => tap(row.pitch)}>{row.name}</button
							>
						{:else}
							<span class="self-center text-left">{row.name}</span>
						{/if}
						{#each columns as step (step)}
							<button
								type="button"
								class="h-7 rounded border border-red-400"
								class:bg-blue-500={hasNote(row.pitch, step)}
								class:bg-slate-100={kind === 'piano' &&
									isBlackKey(row.pitch) &&
									!hasNote(row.pitch, step)}
								class:bg-white={!hasNote(row.pitch, step) &&
									(kind !== 'piano' || !isBlackKey(row.pitch))}
								aria-label={row.name + ', step ' + (step + 1)}
								aria-pressed={hasNote(row.pitch, step)}
								disabled={recording ||
									vocalRecording ||
									vocalStarting ||
									vocalProcessing ||
									calibrationBusy}
								onclick={() => toggleCell(row.pitch, step)}
							></button>
						{/each}
					{/each}
				</div>
			</div>
		</div>
		{#if kind === 'piano'}
			<div class="shrink-0">
				<PianoKeyboard
					onPlay={tap}
					onPress={pressPiano}
					onMove={bendPiano}
					onRelease={releasePiano}
					{playingPitches}
				/>
			</div>
		{/if}
	</div>
</section>
