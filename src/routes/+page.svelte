<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { Pane, PaneGroup, PaneResizer } from 'paneforge';
	import DawTrackList from '#lib/DawTrackList.svelte';
	import PlayBackBar from '#lib/PlayBackBar.svelte';
	import SynthEditor from '#lib/SynthEditor.svelte';
	import type { ClipDraft, Track } from '#lib/daw.js';
	import type { Instrument } from '#lib/synth.js';
	import type { VoiceCalibration } from '#lib/vocalGuidance.js';

	let tracks = $state<Track[]>([]);
	let activeInstrument = $state<Instrument | null>(null);
	let vocalCalibrations = $state<Partial<Record<Instrument, VoiceCalibration>>>({});
	let fileInput: HTMLInputElement;
	let nextTrackId = 0;
	let nextClipId = 0;
	let arrangementVersion = $state(0);
	let playhead = $state(0);
	let loadingCount = $state(0);
	let message = $state('');
	let recordingTrackId = $state<number | null>(null);
	let audioInsertIndex: number | null = null;
	type Action = 'audio' | 'piano' | 'drums' | 'empty';
	let actionDrag = $state<{
		action: Action;
		pointerId: number;
		x: number;
		y: number;
		index: number | null;
		lineY: number | null;
	} | null>(null);
	let actionStart: { action: Action; pointerId: number; x: number; y: number } | null = null;
	let ignoreClick = false;
	let trackCanvas: HTMLDivElement;
	let workspace: HTMLDivElement;
	let synthPane = $state<{ getSize: () => number; resize: (size: number) => void } | undefined>();
	let floating = $state(false);
	let dockedSynthSize = 40;
	let floatLeft = $state(24);
	let floatTop = $state(24);
	let floatWidth = $state(680);
	let floatHeight = $state(480);
	let movingPane: { pointerId: number; x: number; y: number; left: number; top: number } | null =
		null;
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

	async function addTrack(
		draft: ClipDraft,
		targetId: number | null = null,
		insertIndex: number | null = null
	) {
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
			if (targetId !== null && tracks.some((track) => track.id === targetId)) {
				tracks = tracks.map((track) =>
					track.id === targetId ? { ...track, clips: [...track.clips, clip] } : track
				);
			} else {
				const track = {
					id: nextTrackId++,
					name: draft.name,
					volume: 0.8,
					muted: false,
					solo: false,
					clips: [clip]
				};
				const index = insertIndex === null ? tracks.length : Math.min(insertIndex, tracks.length);
				tracks = [...tracks.slice(0, index), track, ...tracks.slice(index)];
			}
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
		const index = audioInsertIndex;
		audioInsertIndex = null;
		for (const [offset, file] of files.entries())
			void addTrack(
				{ name: file.name, blob: file },
				null,
				index === null ? null : index + offset
			).catch(() => {});
		input.value = '';
	}

	function addEmptyTrack(index = tracks.length, name?: string) {
		const id = nextTrackId++;
		const track = {
			id,
			name: name ?? 'Track ' + (id + 1),
			volume: 0.8,
			muted: false,
			solo: false,
			clips: []
		};
		tracks = [...tracks.slice(0, index), track, ...tracks.slice(index)];
		return id;
	}

	function openAudio(index: number | null = null) {
		audioInsertIndex = index;
		fileInput.click();
	}

	function startAction(event: PointerEvent, action: Action) {
		if (event.button !== 0) return;
		actionStart = { action, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function dropPosition(x: number, y: number) {
		const bounds = trackCanvas.getBoundingClientRect();
		if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
		const rows = Array.from(trackCanvas.querySelectorAll<HTMLElement>('[data-track-row]'));
		const header = trackCanvas.querySelector<HTMLElement>('[data-track-header]');
		for (const [index, row] of rows.entries()) {
			const rect = row.getBoundingClientRect();
			if (y < rect.top + rect.height / 2) return { index, lineY: rect.top - bounds.top };
		}
		const bottom =
			rows.at(-1)?.getBoundingClientRect().bottom ??
			header?.getBoundingClientRect().bottom ??
			bounds.top;
		return { index: rows.length, lineY: Math.min(bottom - bounds.top, bounds.height - 2) };
	}

	function moveAction(event: PointerEvent) {
		if (!actionStart || actionStart.pointerId !== event.pointerId) return;
		if (!actionDrag && Math.hypot(event.clientX - actionStart.x, event.clientY - actionStart.y) < 6)
			return;
		const position = dropPosition(event.clientX, event.clientY);
		actionDrag = {
			action: actionStart.action,
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			index: position?.index ?? null,
			lineY: position?.lineY ?? null
		};
	}

	function endAction(event: PointerEvent) {
		if (!actionStart || actionStart.pointerId !== event.pointerId) return;
		const action = actionStart.action;
		const dragged = actionDrag !== null;
		const position = dropPosition(event.clientX, event.clientY);
		actionStart = null;
		actionDrag = null;
		if (!dragged) return;
		ignoreClick = true;
		setTimeout(() => (ignoreClick = false), 0);
		if (!position) return;
		if (action === 'audio') openAudio(position.index);
		else if (action === 'empty') addEmptyTrack(position.index);
		else {
			recordingTrackId = addEmptyTrack(position.index, action === 'piano' ? 'Piano' : 'Drums');
			activeInstrument = action;
		}
	}

	function actionClick(action: Action) {
		if (ignoreClick) {
			ignoreClick = false;
			return;
		}
		if (action === 'audio') openAudio();
		else if (action === 'empty') addEmptyTrack();
		else {
			recordingTrackId = null;
			activeInstrument = activeInstrument === action ? null : action;
			if (!activeInstrument) floating = false;
		}
	}

	function zoomPane(delta: number) {
		if (floating) {
			const bounds = workspace.getBoundingClientRect();
			floatWidth = Math.max(120, Math.min(bounds.width - 16, floatWidth + delta * 9));
			floatHeight = Math.max(150, Math.min(bounds.height - 16, floatHeight + delta * 6));
			floatLeft = Math.max(0, Math.min(floatLeft, bounds.width - floatWidth));
			floatTop = Math.max(0, Math.min(floatTop, bounds.height - floatHeight));
		} else if (synthPane) {
			dockedSynthSize = Math.max(18, Math.min(75, synthPane.getSize() + delta));
			synthPane.resize(dockedSynthSize);
		}
	}

	async function toggleFloat() {
		if (!synthPane) return;
		if (!floating) {
			dockedSynthSize = Math.max(18, synthPane.getSize());
			const bounds = workspace.getBoundingClientRect();
			floatWidth = Math.max(120, Math.min(760, bounds.width - 16, bounds.width * 0.8));
			floatHeight = Math.max(150, Math.min(560, bounds.height - 16, bounds.height * 0.72));
			floatLeft = Math.max(0, (bounds.width - floatWidth) / 2);
			floatTop = Math.max(0, (bounds.height - floatHeight) / 2);
			synthPane.resize(0);
			floating = true;
		} else {
			floating = false;
			await tick();
			synthPane?.resize(dockedSynthSize);
		}
	}

	function startPaneMove(event: PointerEvent) {
		if (!floating || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
		movingPane = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			left: floatLeft,
			top: floatTop
		};
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function movePane(event: PointerEvent) {
		if (!movingPane || movingPane.pointerId !== event.pointerId) return;
		const bounds = workspace.getBoundingClientRect();
		floatLeft = Math.max(
			0,
			Math.min(bounds.width - floatWidth, movingPane.left + event.clientX - movingPane.x)
		);
		floatTop = Math.max(
			0,
			Math.min(bounds.height - floatHeight, movingPane.top + event.clientY - movingPane.y)
		);
	}

	function stopPaneMove(event: PointerEvent) {
		if (movingPane?.pointerId === event.pointerId) movingPane = null;
	}

	function movePaneWithKeyboard(event: KeyboardEvent) {
		if (!floating || event.target !== event.currentTarget) return;
		const offset = event.shiftKey ? 50 : 10;
		const bounds = workspace.getBoundingClientRect();
		if (event.key === 'ArrowLeft') floatLeft = Math.max(0, floatLeft - offset);
		else if (event.key === 'ArrowRight')
			floatLeft = Math.min(bounds.width - floatWidth, floatLeft + offset);
		else if (event.key === 'ArrowUp') floatTop = Math.max(0, floatTop - offset);
		else if (event.key === 'ArrowDown')
			floatTop = Math.min(bounds.height - floatHeight, floatTop + offset);
		else return;
		event.preventDefault();
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

<div class="flex h-svh w-full flex-col overflow-hidden bg-red-300">
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<aside
			class="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-red-400 p-1"
			aria-label="Track actions"
		>
			<input
				bind:this={fileInput}
				type="file"
				accept="audio/*"
				multiple
				class="hidden"
				aria-label="Add audio files"
				onchange={addFiles}
			/>
			<button
				type="button"
				class="flex h-9 w-9 touch-none items-center justify-center rounded border-2 font-semibold"
				aria-label="Add audio files"
				title="Add audio files or drag onto tracks"
				onpointerdown={(event) => startAction(event, 'audio')}
				onpointermove={moveAction}
				onpointerup={endAction}
				onpointercancel={() => {
					actionStart = null;
					actionDrag = null;
				}}
				onclick={() => actionClick('audio')}
			>
				A
			</button>
			<button
				type="button"
				class="flex h-9 w-9 touch-none items-center justify-center rounded border-2 font-semibold"
				class:bg-red-100={activeInstrument === 'piano'}
				aria-label="Piano roll"
				title="Piano roll or drag onto tracks"
				aria-pressed={activeInstrument === 'piano'}
				onpointerdown={(event) => startAction(event, 'piano')}
				onpointermove={moveAction}
				onpointerup={endAction}
				onpointercancel={() => {
					actionStart = null;
					actionDrag = null;
				}}
				onclick={() => actionClick('piano')}
			>
				P
			</button>
			<button
				type="button"
				class="flex h-9 w-9 touch-none items-center justify-center rounded border-2 font-semibold"
				class:bg-red-100={activeInstrument === 'drums'}
				aria-label="Drum machine"
				title="Drum machine or drag onto tracks"
				aria-pressed={activeInstrument === 'drums'}
				onpointerdown={(event) => startAction(event, 'drums')}
				onpointermove={moveAction}
				onpointerup={endAction}
				onpointercancel={() => {
					actionStart = null;
					actionDrag = null;
				}}
				onclick={() => actionClick('drums')}
			>
				D
			</button>
			<button
				type="button"
				class="flex h-9 w-9 touch-none items-center justify-center rounded border-2 font-semibold"
				aria-label="Add empty track"
				title="Add empty track or drag onto tracks"
				onpointerdown={(event) => startAction(event, 'empty')}
				onpointermove={moveAction}
				onpointerup={endAction}
				onpointercancel={() => {
					actionStart = null;
					actionDrag = null;
				}}
				onclick={() => actionClick('empty')}
			>
				E
			</button>
		</aside>
		<div
			bind:this={workspace}
			class="relative min-h-0 min-w-0 flex-1"
			style={`--float-left:${floatLeft}px;--float-top:${floatTop}px;--float-width:${floatWidth}px;--float-height:${floatHeight}px`}
		>
			<PaneGroup direction="vertical" class="h-full min-h-0 w-full">
				<Pane defaultSize={activeInstrument ? 60 : 100} minSize={25} class="min-h-0 min-w-0">
					<div bind:this={trackCanvas} class="relative h-full min-h-0 min-w-0">
						<DawTrackList {tracks} {playhead} onMixChange={changeMix} onMove={moveClip} />
						{#if actionDrag?.lineY !== null && actionDrag?.lineY !== undefined}
							<div
								class="pointer-events-none absolute right-0 left-0 z-50 h-0.5 bg-yellow-300 shadow-[0_0_8px_#fde047]"
								style:top={actionDrag.lineY + 'px'}
							></div>
						{/if}
						{#if loadingCount || message}
							<p
								class="absolute right-2 bottom-2 z-40 rounded bg-slate-800 px-2 py-1 text-xs text-white"
								role="status"
							>
								{message || `Loading ${loadingCount} clip${loadingCount === 1 ? '' : 's'}…`}
							</p>
						{/if}
					</div>
				</Pane>
				{#if activeInstrument}
					<PaneResizer
						class={floating
							? 'hidden'
							: 'group relative z-30 h-2 shrink-0 cursor-row-resize touch-none bg-slate-700 hover:bg-slate-500'}
					/>
					<Pane
						bind:this={synthPane}
						defaultSize={40}
						minSize={0}
						class={floating ? 'floating-synth min-h-0 min-w-0' : 'min-h-0 min-w-0'}
					>
						<div
							class="flex h-full min-h-0 flex-col overflow-hidden border border-slate-600 bg-red-200"
						>
							<div
								role="toolbar"
								tabindex="0"
								aria-label="Synth pane controls"
								class="flex h-9 shrink-0 touch-none items-center justify-between gap-2 bg-slate-800 px-2 text-sm text-white"
								class:cursor-move={floating}
								onpointerdown={startPaneMove}
								onpointermove={movePane}
								onpointerup={stopPaneMove}
								onpointercancel={stopPaneMove}
								onkeydown={movePaneWithKeyboard}
							>
								<span class="truncate font-semibold"
									>{activeInstrument === 'piano' ? 'Piano roll' : 'Drum machine'}{floating
										? ' · drag to move'
										: ''}</span
								>
								<div class="flex shrink-0 items-center gap-1">
									<button
										type="button"
										class="rounded border px-2"
										aria-label="Zoom synth pane out"
										title="Zoom out"
										onclick={() => zoomPane(-6)}>−</button
									>
									<button
										type="button"
										class="rounded border px-2"
										aria-label="Zoom synth pane in"
										title="Zoom in"
										onclick={() => zoomPane(6)}>+</button
									>
									<button
										type="button"
										class="rounded border px-2"
										aria-label={floating ? 'Dock synth pane' : 'Float synth pane'}
										title={floating ? 'Dock pane' : 'Move pane freely'}
										onclick={toggleFloat}>{floating ? 'Dock' : 'Float'}</button
									>
									<button
										type="button"
										class="rounded border px-2"
										aria-label="Close synth pane"
										title="Close pane"
										onclick={() => {
											activeInstrument = null;
											floating = false;
										}}>×</button
									>
								</div>
							</div>
							{#key activeInstrument}
								<SynthEditor
									kind={activeInstrument}
									onSave={(draft) => addTrack(draft, recordingTrackId)}
									calibration={vocalCalibrations[activeInstrument]}
									onCalibrate={(instrument, result) =>
										(vocalCalibrations = { ...vocalCalibrations, [instrument]: result })}
								/>
							{/key}
						</div>
					</Pane>
				{/if}
			</PaneGroup>
		</div>
	</div>
	{#if actionDrag}
		<div
			class="pointer-events-none fixed z-50 flex h-9 w-9 items-center justify-center rounded border-2 border-yellow-300 bg-slate-800 font-semibold text-white shadow-lg"
			style:left={actionDrag.x + 12 + 'px'}
			style:top={actionDrag.y + 12 + 'px'}
		>
			{actionDrag.action === 'audio'
				? 'A'
				: actionDrag.action === 'piano'
					? 'P'
					: actionDrag.action === 'drums'
						? 'D'
						: 'E'}
		</div>
	{/if}
	<PlayBackBar {tracks} {buffers} {arrangementVersion} onTimeChange={(time) => (playhead = time)} />
</div>

<style>
	:global(.floating-synth) {
		position: absolute !important;
		left: var(--float-left) !important;
		top: var(--float-top) !important;
		width: var(--float-width) !important;
		height: var(--float-height) !important;
		z-index: 40;
		flex: none !important;
		box-shadow: 0 16px 40px rgb(0 0 0 / 0.45);
	}
</style>
