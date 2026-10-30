<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import DawTrackList from '#lib/DawTrackList.svelte';
	import PlayBackBar from '#lib/PlayBackBar.svelte';
	import SynthEditor from '#lib/SynthEditor.svelte';
	import type { ClipDraft, Track } from '#lib/daw.js';
	import type { Instrument } from '#lib/synth.js';

	let tracks = $state<Track[]>([]);
	let activeInstrument = $state<Instrument | null>(null);
	let fileInput: HTMLInputElement;
	let nextTrackId = 0;
	let nextClipId = 0;
	let arrangementVersion = $state(0);
	let playhead = $state(0);
	let loadingCount = $state(0);
	let message = $state('');
	let decoder: AudioContext | undefined;
	let disposed = false;
	const buffers = new SvelteMap<number, AudioBuffer>();

	function waveform(buffer: AudioBuffer) {
		const samples = buffer.getChannelData(0);
		const columns = 64;
		const bucket = Math.max(1, Math.floor(samples.length / columns));
		return Array.from({ length: columns }, (_, index) => {
			let peak = 0;
			const start = index * bucket;
			const end = Math.min(samples.length, start + bucket);
			const stride = Math.max(1, Math.floor((end - start) / 128));
			for (let i = start; i < end; i += stride) peak = Math.max(peak, Math.abs(samples[i]));
			return peak;
		});
	}

	async function addTrack(draft: ClipDraft) {
		loadingCount++;
		try {
			decoder ??= new AudioContext();
			const buffer = await decoder.decodeAudioData(await draft.blob.arrayBuffer());
			if (disposed) return;
			const id = nextClipId++;
			const loop = draft.loop ?? false;
			const patternDuration = buffer.duration;
			const clip = {
				id,
				name: draft.name,
				url: URL.createObjectURL(draft.blob),
				start: 0,
				duration: patternDuration * (loop ? 4 : 1),
				patternDuration,
				loop,
				instrument: draft.instrument,
				notes: draft.notes,
				bpm: draft.bpm,
				waveform: draft.notes ? undefined : waveform(buffer)
			};
			buffers.set(id, buffer);
			tracks = [
				...tracks,
				{
					id: nextTrackId++,
					name: draft.name,
					volume: 0.8,
					muted: false,
					solo: false,
					clips: [clip]
				}
			];
			arrangementVersion++;
			message = '';
		} catch {
			message = 'Could not load the audio clip.';
			throw new Error('Could not load the audio clip.');
		} finally {
			loadingCount--;
		}
	}

	function addFiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []).filter((file) => file.type.startsWith('audio/'));
		for (const file of files) void addTrack({ name: file.name, blob: file }).catch(() => {});
		input.value = '';
	}

	function addEmptyTrack() {
		tracks = [
			...tracks,
			{
				id: nextTrackId++,
				name: 'Track ' + nextTrackId,
				volume: 0.8,
				muted: false,
				solo: false,
				clips: []
			}
		];
	}

	function changeMix(id: number, patch: Partial<Pick<Track, 'volume' | 'muted' | 'solo'>>) {
		tracks = tracks.map((track) => (track.id === id ? { ...track, ...patch } : track));
	}

	function moveClip(clipId: number, fromId: number, toId: number, start: number) {
		const source = tracks.find((track) => track.id === fromId);
		const target = tracks.find((track) => track.id === toId);
		const clip = source?.clips.find((item) => item.id === clipId);
		if (!source || !target || !clip) return;
		if (fromId === toId && clip.start === start) return;
		tracks = tracks.map((track) => {
			if (track.id === fromId && track.id === toId) {
				return {
					...track,
					clips: track.clips.map((item) => (item.id === clipId ? { ...item, start } : item))
				};
			}
			if (track.id === fromId)
				return { ...track, clips: track.clips.filter((item) => item.id !== clipId) };
			if (track.id === toId) return { ...track, clips: [...track.clips, { ...clip, start }] };
			return track;
		});
		arrangementVersion++;
	}

	onDestroy(() => {
		disposed = true;
		if (decoder) void decoder.close();
		for (const track of tracks) for (const clip of track.clips) URL.revokeObjectURL(clip.url);
	});
</script>

<div class="flex h-full w-full flex-col bg-red-300">
	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="flex flex-wrap gap-2 p-4">
			<input
				bind:this={fileInput}
				type="file"
				accept="audio/*"
				multiple
				class="hidden"
				aria-label="Add audio files"
				onchange={addFiles}
			/>
			<button type="button" class="rounded border-2 px-3 py-2" onclick={() => fileInput.click()}>
				Add audio files
			</button>
			<button
				type="button"
				class="rounded border-2 px-3 py-2"
				aria-pressed={activeInstrument === 'piano'}
				onclick={() => (activeInstrument = activeInstrument === 'piano' ? null : 'piano')}
			>
				Piano roll
			</button>
			<button
				type="button"
				class="rounded border-2 px-3 py-2"
				aria-pressed={activeInstrument === 'drums'}
				onclick={() => (activeInstrument = activeInstrument === 'drums' ? null : 'drums')}
			>
				Drum machine
			</button>
			<button type="button" class="rounded border-2 px-3 py-2" onclick={addEmptyTrack}>
				Add empty track
			</button>
		</div>
		{#if loadingCount}<p class="px-4 pb-2 text-sm">
				Loading {loadingCount} clip{loadingCount === 1 ? '' : 's'}…
			</p>{/if}
		{#if message}<p class="px-4 pb-2 text-sm" role="status">{message}</p>{/if}
		<div class="px-4 pb-4">
			<DawTrackList {tracks} {playhead} onMixChange={changeMix} onMove={moveClip} />
		</div>
	</div>
	{#if activeInstrument}
		{#key activeInstrument}
			<SynthEditor kind={activeInstrument} onSave={addTrack} />
		{/key}
	{/if}
	<PlayBackBar {tracks} {buffers} {arrangementVersion} onTimeChange={(time) => (playhead = time)} />
</div>
