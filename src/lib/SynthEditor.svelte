<script lang="ts">
	import { onDestroy } from 'svelte';
	import PianoKeyboard from '#lib/PianoKeyboard.svelte';
	import type { ClipDraft } from '#lib/daw.js';
	import {
		BEATS,
		STEPS,
		barLength,
		labels,
		playNote,
		renderTrack,
		schedule,
		type Instrument,
		type Note
	} from '#lib/synth.js';
	import { analyzeVoice } from '#lib/vocalGuidance.js';

	let {
		kind,
		onSave
	}: {
		kind: Instrument;
		onSave: (clip: ClipDraft) => Promise<void>;
	} = $props();

	let bpm = $state(120);
	let notes = $state<Note[]>([]);
	let recording = $state(false);
	let previewing = $state(false);
	let saving = $state(false);
	let loopEnabled = $state(false);
	let vocalRecording = $state(false);
	let vocalStarting = $state(false);
	let vocalProcessing = $state(false);
	let message = $state('');
	let context: AudioContext | undefined;
	let previewContext: AudioContext | undefined;
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	let recordTimer: ReturnType<typeof setTimeout> | undefined;
	let recordStart = 0;
	let takeNumber = 1;
	let recorder: MediaRecorder | undefined;
	let microphone: MediaStream | undefined;
	let vocalTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const columns = Array.from({ length: STEPS }, (_, index) => index);
	const blackPitches = new Set([1, 3, 6, 8, 10]);
	const isBlackKey = (pitch: number) => blackPitches.has(pitch % 12);
	let tempo = $derived(Math.min(240, Math.max(40, Number(bpm) || 120)));
	let stepLength = $derived((60 / tempo) * (BEATS / STEPS));

	async function tap(pitch: number) {
		if (recording) {
			const start = (performance.now() - recordStart) / 1000;
			if (start < barLength(tempo)) notes = [...notes, { pitch, start }];
		}
		try {
			context ??= new AudioContext();
			await context.resume();
			playNote(context, kind, pitch, context.currentTime + 0.01, kind === 'piano' ? 0.25 : 0.18);
		} catch {
			message = 'Audio playback is unavailable in this browser.';
		}
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
		if (recordTimer) clearTimeout(recordTimer);
		recordTimer = undefined;
		recording = false;
		message = notes.length
			? 'Take captured. Quantize or save it as a track.'
			: 'No notes captured.';
	}

	function toggleRecording() {
		if (recording) {
			stopRecording();
			return;
		}
		stopPreview();
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

	async function toggleVocal() {
		if (vocalRecording) {
			stopVocal();
			return;
		}
		if (vocalStarting || vocalProcessing) return;
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
					notes = analyzeVoice(channel, buffer.sampleRate, capturedKind, capturedTempo);
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
			const previewTempo = tempo;
			const previewNotes = notes.map((note) => ({ ...note }));
			const bar = barLength(previewTempo);
			let nextStart = activeContext.currentTime + 0.05;
			previewing = true;
			if (loopEnabled) {
				const queueBars = () => {
					if (previewContext !== activeContext) return;
					while (nextStart < activeContext.currentTime + bar * 1.5) {
						schedule(activeContext, kind, previewNotes, previewTempo, nextStart, true);
						nextStart += bar;
					}
					previewTimer = setTimeout(queueBars, Math.min(250, bar * 250));
				};
				queueBars();
			} else {
				schedule(activeContext, kind, previewNotes, previewTempo, nextStart);
				previewTimer = setTimeout(stopPreview, (bar + 0.3) * 1000);
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
			const blob = await renderTrack(kind, notes, tempo, loopEnabled);
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
		if (vocalTimer) clearTimeout(vocalTimer);
		if (recorder?.state === 'recording') recorder.stop();
		if (microphone) for (const track of microphone.getTracks()) track.stop();
		if (recordTimer) clearTimeout(recordTimer);
		stopPreview();
		if (context) void context.close();
	});
</script>

<section class="border-b border-red-400 bg-red-200 p-4">
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<h2 class="text-lg font-semibold">{kind === 'piano' ? 'Piano roll' : 'Drum machine'}</h2>
		<label class="flex items-center gap-2">
			BPM
			<input
				type="number"
				min="40"
				max="240"
				bind:value={bpm}
				disabled={recording || previewing || vocalRecording || vocalStarting || vocalProcessing}
				class="w-18 rounded border bg-white px-1"
			/>
		</label>
		<button
			type="button"
			class="rounded border px-2 py-1"
			disabled={vocalRecording || vocalStarting || vocalProcessing}
			onclick={toggleRecording}
		>
			{recording ? 'Stop recording' : 'Record notes'}
		</button>
		<button
			type="button"
			class="rounded border px-2 py-1"
			disabled={recording || vocalStarting || vocalProcessing}
			onclick={toggleVocal}
		>
			{vocalRecording ? 'Stop vocal guidance' : 'Vocal guidance'}
		</button>
		<button
			type="button"
			class="rounded border px-2 py-1"
			disabled={!notes.length || recording || vocalRecording || vocalStarting || vocalProcessing}
			onclick={quantize}
		>
			Quantize
		</button>
		<label class="flex items-center gap-1">
			<input
				type="checkbox"
				bind:checked={loopEnabled}
				disabled={recording || previewing || vocalRecording || vocalStarting || vocalProcessing}
			/>
			Loop pattern
		</label>
		<button
			type="button"
			class="rounded border px-2 py-1"
			disabled={!notes.length || recording || vocalRecording || vocalStarting || vocalProcessing}
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
			disabled={recording || vocalRecording || vocalStarting || vocalProcessing || !notes.length}
			onclick={() => {
				notes = [];
				message = '';
				stopPreview();
			}}
		>
			Clear
		</button>
	</div>
	<p class="mb-2 text-sm">
		Tap the keys, use vocal guidance, or click cells to build a one-bar pattern. Each column is a
		sixteenth note.
	</p>
	{#if kind === 'piano'}
		<div class="mb-3">
			<PianoKeyboard onPlay={tap} />
		</div>
	{:else}
		<div class="mb-3 flex flex-wrap gap-2">
			{#each labels[kind] as row (row.pitch)}
				<button
					type="button"
					class="rounded border-2 border-red-500 bg-white px-3 py-2 active:bg-yellow-200"
					onclick={() => tap(row.pitch)}
				>
					{row.name}
				</button>
			{/each}
		</div>
	{/if}
	<div class="overflow-x-auto">
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
							class:bg-slate-900={isBlackKey(row.pitch)}
							class:text-white={isBlackKey(row.pitch)}
							class:bg-white={!isBlackKey(row.pitch)}
							class:pl-4={isBlackKey(row.pitch)}
							class:pl-2={!isBlackKey(row.pitch)}
							aria-label={'Play ' + row.name}
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
							disabled={recording || vocalRecording || vocalStarting || vocalProcessing}
							onclick={() => toggleCell(row.pitch, step)}
						></button>
					{/each}
				{/each}
			</div>
		</div>
	</div>
	{#if message}<p class="mt-2 text-sm" role="status">{message}</p>{/if}
</section>
