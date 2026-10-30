<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { timelineLength, type Track } from '#lib/daw.js';

	let {
		tracks,
		buffers,
		arrangementVersion,
		onTimeChange
	}: {
		tracks: Track[];
		buffers: Map<number, AudioBuffer>;
		arrangementVersion: number;
		onTimeChange: (time: number) => void;
	} = $props();

	let playing = $state(false);
	let starting = $state(false);
	let currentTime = $state(0);
	let duration = $derived(timelineLength(tracks));
	let hasClips = $derived(tracks.some((track) => track.clips.some((clip) => buffers.has(clip.id))));
	let context: AudioContext | undefined;
	let startedAt = 0;
	let frame: number | undefined;
	const sources: AudioBufferSourceNode[] = [];
	const gains = new SvelteMap<number, GainNode>();
	let previousVersion = -1;

	function formatTime(seconds: number) {
		const whole = Math.floor(Math.max(0, seconds));
		return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
	}

	function updateMix(snapshot: Track[]) {
		const soloed = snapshot.some((track) => track.solo);
		for (const track of snapshot) {
			const gain = gains.get(track.id);
			if (!gain || !context) continue;
			const audible = !track.muted && (!soloed || track.solo);
			gain.gain.setTargetAtTime(audible ? track.volume : 0, context.currentTime, 0.01);
		}
	}

	$effect(() => {
		updateMix(tracks);
	});

	$effect(() => {
		const nextVersion = arrangementVersion;
		if (nextVersion === previousVersion) return;
		const initial = previousVersion < 0;
		previousVersion = nextVersion;
		if (initial) return;
		untrack(() => {
			if (playing) {
				pause();
				void play();
			}
		});
	});

	function releaseAudio() {
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = undefined;
		for (const source of sources) {
			try {
				source.stop();
			} catch {
				// A clip may have already reached its end.
			}
		}
		sources.length = 0;
		gains.clear();
		if (context) void context.close();
		context = undefined;
		playing = false;
		starting = false;
	}

	function pause() {
		if (context) {
			currentTime = Math.min(duration, context.currentTime - startedAt);
			onTimeChange(currentTime);
		}
		releaseAudio();
	}

	function stop() {
		releaseAudio();
		currentTime = 0;
		onTimeChange(0);
	}

	function tick() {
		if (!context) return;
		currentTime = Math.min(duration, context.currentTime - startedAt);
		onTimeChange(currentTime);
		if (currentTime >= duration) {
			stop();
			return;
		}
		frame = requestAnimationFrame(tick);
	}

	async function play() {
		if (!hasClips || playing || starting) return;
		starting = true;
		if (currentTime >= duration) currentTime = 0;
		try {
			const activeContext = new AudioContext();
			context = activeContext;
			await activeContext.resume();
			if (context !== activeContext) {
				void activeContext.close();
				return;
			}
			startedAt = activeContext.currentTime - currentTime;
			for (const track of tracks) {
				const gain = activeContext.createGain();
				gain.connect(activeContext.destination);
				gain.gain.value = 0;
				gains.set(track.id, gain);
				for (const clip of track.clips) {
					const buffer = buffers.get(clip.id);
					if (!buffer || clip.start + clip.duration <= currentTime) continue;
					const source = activeContext.createBufferSource();
					source.buffer = buffer;
					source.loop = clip.loop;
					source.connect(gain);
					const elapsed = Math.max(0, currentTime - clip.start);
					const offset = clip.loop ? elapsed % buffer.duration : elapsed;
					if (!clip.loop && offset >= buffer.duration) continue;
					const delay = Math.max(0, clip.start - currentTime);
					source.start(activeContext.currentTime + delay, offset);
					source.stop(activeContext.currentTime + clip.start + clip.duration - currentTime);
					sources.push(source);
				}
			}
			updateMix(tracks);
			playing = true;
			starting = false;
			frame = requestAnimationFrame(tick);
		} catch {
			releaseAudio();
		}
	}

	function seek(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const resume = playing;
		if (resume) pause();
		currentTime = Number(input.value);
		onTimeChange(currentTime);
		if (resume) void play();
	}

	onDestroy(releaseAudio);
</script>

<div id="PlaybackBar" class="flex min-h-[60px] shrink-0 items-center gap-4 bg-blue-400 p-4">
	<button
		type="button"
		class="rounded-md border-2 px-2"
		disabled={!hasClips || starting}
		onclick={() => (playing ? pause() : play())}
	>
		{playing ? 'Pause' : 'Play'}
	</button>
	<button type="button" class="rounded-md border-2 px-2" disabled={!hasClips} onclick={stop}>
		Stop
	</button>
	<input
		type="range"
		class="min-w-0 flex-1"
		min="0"
		max={duration}
		step="0.01"
		value={currentTime}
		disabled={!hasClips}
		aria-label="Timeline position"
		oninput={seek}
	/>
	<span class="whitespace-nowrap">{formatTime(currentTime)} / {formatTime(duration)}</span>
</div>
