<script lang="ts">
	let { onPlay }: { onPlay: (pitch: number) => void } = $props();

	const whiteKeys = [
		{ name: 'C4', pitch: 60 },
		{ name: 'D4', pitch: 62 },
		{ name: 'E4', pitch: 64 },
		{ name: 'F4', pitch: 65 },
		{ name: 'G4', pitch: 67 },
		{ name: 'A4', pitch: 69 },
		{ name: 'B4', pitch: 71 },
		{ name: 'C5', pitch: 72 }
	];
	const blackKeys = [
		{ name: 'C#4', pitch: 61, after: 0 },
		{ name: 'D#4', pitch: 63, after: 1 },
		{ name: 'F#4', pitch: 66, after: 3 },
		{ name: 'G#4', pitch: 68, after: 4 },
		{ name: 'A#4', pitch: 70, after: 5 }
	];
</script>

<div
	class="relative flex h-28 w-full max-w-2xl rounded-md border-2 border-slate-800 bg-slate-800 p-0.5 select-none"
	aria-label="Playable piano keyboard"
>
	{#each whiteKeys as key (key.pitch)}
		<button
			type="button"
			class="flex min-w-0 flex-1 items-end justify-center rounded-b-md border border-slate-700 bg-white pb-2 text-xs text-slate-700 active:bg-blue-200"
			aria-label={'Play ' + key.name}
			onclick={() => onPlay(key.pitch)}
		>
			{key.name}
		</button>
	{/each}
	{#each blackKeys as key (key.pitch)}
		<button
			type="button"
			class="absolute top-0 z-10 flex h-[64%] w-[8%] items-end justify-center rounded-b-md border border-slate-950 bg-slate-900 pb-2 text-[10px] text-white shadow-md active:bg-blue-700"
			style:left={((key.after + 1) / whiteKeys.length) * 100 - 4 + '%'}
			aria-label={'Play ' + key.name}
			onclick={() => onPlay(key.pitch)}
		>
			{key.name}
		</button>
	{/each}
</div>
