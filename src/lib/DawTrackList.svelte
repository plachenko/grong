<script lang="ts">
	import {
		PIXELS_PER_SECOND,
		SNAP_SECONDS,
		timelineLength,
		type Clip,
		type Track
	} from '#lib/daw.js';

	let {
		tracks,
		playhead,
		onMixChange,
		onMove
	}: {
		tracks: Track[];
		playhead: number;
		onMixChange: (id: number, patch: Partial<Pick<Track, 'volume' | 'muted' | 'solo'>>) => void;
		onMove: (clipId: number, fromId: number, toId: number, start: number) => void;
	} = $props();

	type Drag = {
		clipId: number;
		fromId: number;
		toId: number;
		startX: number;
		origin: number;
		preview: number;
	};
	let drag = $state<Drag | null>(null);
	let seconds = $derived(timelineLength(tracks));
	let ruler = $derived(Array.from({ length: seconds + 1 }, (_, index) => index));
	let timelineWidth = $derived(seconds * PIXELS_PER_SECOND);

	function snap(time: number) {
		return Math.max(0, Math.round(time / SNAP_SECONDS) * SNAP_SECONDS);
	}

	function targetTrack(x: number, y: number, fallback: number) {
		for (const element of document.elementsFromPoint(x, y)) {
			const id = element.getAttribute('data-track-id');
			if (id !== null) return Number(id);
		}
		return fallback;
	}

	function pointerDown(event: PointerEvent, clip: Clip, trackId: number) {
		if (event.button !== 0) return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = {
			clipId: clip.id,
			fromId: trackId,
			toId: trackId,
			startX: event.clientX,
			origin: clip.start,
			preview: clip.start
		};
	}

	function pointerMove(event: PointerEvent) {
		if (!drag) return;
		drag = {
			...drag,
			preview: snap(drag.origin + (event.clientX - drag.startX) / PIXELS_PER_SECOND),
			toId: targetTrack(event.clientX, event.clientY, drag.fromId)
		};
	}

	function pointerUp(event: PointerEvent) {
		if (!drag) return;
		const target = targetTrack(event.clientX, event.clientY, drag.toId);
		onMove(drag.clipId, drag.fromId, target, drag.preview);
		drag = null;
	}

	function keyMove(event: KeyboardEvent, clip: Clip, trackId: number) {
		let target = trackId;
		let start = clip.start;
		if (event.key === 'ArrowLeft') start = snap(start - SNAP_SECONDS);
		else if (event.key === 'ArrowRight') start = snap(start + SNAP_SECONDS);
		else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			const index = tracks.findIndex((track) => track.id === trackId);
			const next = index + (event.key === 'ArrowUp' ? -1 : 1);
			if (tracks[next]) target = tracks[next].id;
		} else return;
		event.preventDefault();
		onMove(clip.id, trackId, target, start);
	}

	function noteBlocks(clip: Clip) {
		if (!clip.notes?.length || !clip.instrument) return [];
		const repeats = clip.loop ? Math.max(1, Math.round(clip.duration / clip.patternDuration)) : 1;
		const blocks: { key: string; left: number; top: number; width: number; bend?: boolean }[] = [];
		for (let repeat = 0; repeat < repeats; repeat++) {
			for (let index = 0; index < clip.notes.length; index++) {
				const note = clip.notes[index];
				const noteTime = repeat * clip.patternDuration + note.start;
				const lane =
					clip.instrument === 'piano'
						? 72 - note.pitch
						: note.pitch === 42
							? 0
							: note.pitch === 38
								? 1
								: 2;
				const rows = clip.instrument === 'piano' ? 13 : 3;
				const naturalWidth =
					note.duration ??
					(clip.instrument === 'piano' && clip.bpm ? 30 / clip.bpm : clip.patternDuration / 16);
				const maxWidth = clip.loop ? clip.patternDuration - note.start : clip.duration - noteTime;
				blocks.push({
					key: repeat + '-' + index,
					left: (noteTime / clip.duration) * 100,
					top: (lane / rows) * 100,
					width: Math.max(1, (Math.min(naturalWidth, maxWidth) / clip.duration) * 100)
				});
				if (clip.instrument === 'piano') {
					for (const [bendIndex, bend] of (note.bends ?? []).entries()) {
						if (bend.time > naturalWidth || bend.time > maxWidth) continue;
						blocks.push({
							key: repeat + '-' + index + '-bend-' + bendIndex,
							left: ((noteTime + bend.time) / clip.duration) * 100,
							top: Math.max(0, Math.min(93, ((72 - bend.pitch) / rows) * 100)),
							width: Math.max(0.4, (0.025 / clip.duration) * 100),
							bend: true
						});
					}
				}
			}
		}
		return blocks;
	}

	function repeatWaveform(clip: Clip) {
		if (!clip.waveform?.length) return [];
		const repeats = clip.loop ? Math.max(1, Math.round(clip.duration / clip.patternDuration)) : 1;
		return Array.from({ length: repeats }, () => clip.waveform ?? []).flat();
	}
</script>

<div class="overflow-x-auto rounded border border-slate-500 bg-slate-950 text-white">
	<div style:width={220 + timelineWidth + 'px'}>
		<div class="flex h-9 border-b border-slate-600">
			<div
				class="sticky left-0 z-30 flex w-[220px] shrink-0 items-center bg-slate-800 px-3 text-sm font-semibold"
			>
				Tracks
			</div>
			<div class="relative h-full shrink-0 bg-slate-800" style:width={timelineWidth + 'px'}>
				{#each ruler as second (second)}
					<div
						class="absolute top-0 h-full border-l border-slate-600 pl-1 text-xs text-slate-300"
						style:left={second * PIXELS_PER_SECOND + 'px'}
					>
						{second}s
					</div>
				{/each}
			</div>
		</div>
		{#each tracks as track (track.id)}
			<div class="flex h-24 border-b border-slate-700">
				<div
					class="sticky left-0 z-30 flex w-[220px] shrink-0 flex-col justify-center gap-1 border-r border-slate-600 bg-slate-800 px-2"
				>
					<div class="truncate text-sm font-medium" title={track.name}>{track.name}</div>
					<div class="flex items-center gap-2">
						<button
							type="button"
							class="rounded border px-2 text-xs"
							class:bg-yellow-500={track.solo}
							class:text-black={track.solo}
							aria-label={'Solo ' + track.name}
							aria-pressed={track.solo}
							onclick={() => onMixChange(track.id, { solo: !track.solo })}>S</button
						>
						<button
							type="button"
							class="rounded border px-2 text-xs"
							class:bg-red-500={track.muted}
							aria-label={'Mute ' + track.name}
							aria-pressed={track.muted}
							onclick={() => onMixChange(track.id, { muted: !track.muted })}>M</button
						>
						<label class="flex min-w-0 flex-1 items-center gap-1 text-xs">
							Vol
							<input
								type="range"
								min="0"
								max="100"
								value={Math.round(track.volume * 100)}
								aria-label={'Volume for ' + track.name}
								class="min-w-0 flex-1"
								oninput={(event) =>
									onMixChange(track.id, {
										volume: Number((event.currentTarget as HTMLInputElement).value) / 100
									})}
							/>
						</label>
					</div>
				</div>
				<div
					class="timeline-grid relative h-24 shrink-0"
					style:width={timelineWidth + 'px'}
					data-track-id={track.id}
				>
					{#each track.clips as clip (clip.id)}
						{@const active = drag?.clipId === clip.id}
						{@const trackOffset = active
							? tracks.findIndex((row) => row.id === drag?.toId) -
								tracks.findIndex((row) => row.id === track.id)
							: 0}
						<button
							type="button"
							class="absolute top-3 z-10 h-[70px] touch-none overflow-hidden rounded border border-sky-300 bg-sky-700 text-left shadow-md"
							class:z-20={active}
							style:left={(active ? (drag?.preview ?? clip.start) : clip.start) *
								PIXELS_PER_SECOND +
								'px'}
							style:width={Math.max(48, clip.duration * PIXELS_PER_SECOND) + 'px'}
							style:transform={active ? 'translateY(' + trackOffset * 96 + 'px)' : undefined}
							aria-label={clip.name + '. Drag to move; arrow keys move by grid step or track.'}
							onpointerdown={(event) => pointerDown(event, clip, track.id)}
							onpointermove={pointerMove}
							onpointerup={pointerUp}
							onpointercancel={() => (drag = null)}
							onkeydown={(event) => keyMove(event, clip, track.id)}
						>
							<span class="absolute top-0 left-1 z-10 truncate text-xs font-medium"
								>{clip.name}{clip.loop ? ' ⟳' : ''}</span
							>
							{#if clip.notes?.length}
								<div class="absolute inset-x-0 top-5 bottom-1">
									{#each noteBlocks(clip) as note (note.key)}
										<span
											class="absolute h-[7%] min-h-[2px] rounded-sm"
											class:bg-cyan-200={note.bend}
											class:bg-lime-300={!note.bend}
											style:left={note.left + '%'}
											style:top={note.top + '%'}
											style:width={note.width + '%'}
										></span>
									{/each}
								</div>
							{:else if clip.waveform?.length}
								<div class="absolute inset-x-1 top-5 bottom-1 flex items-center gap-px">
									{#each repeatWaveform(clip) as peak, index (index)}
										<span
											class="min-w-0 flex-1 bg-sky-200"
											style:height={Math.max(2, peak * 100) + '%'}
										></span>
									{/each}
								</div>
							{/if}
						</button>
					{/each}
					<div
						class="pointer-events-none absolute top-0 z-20 h-full w-px bg-red-400"
						style:left={playhead * PIXELS_PER_SECOND + 'px'}
					></div>
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.timeline-grid {
		background-image:
			repeating-linear-gradient(to right, transparent 0 9px, rgba(255, 255, 255, 0.05) 9px 10px),
			repeating-linear-gradient(to right, transparent 0 39px, rgba(255, 255, 255, 0.12) 39px 40px);
	}
</style>
