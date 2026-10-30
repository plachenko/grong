import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const pagesBase = process.env.GITHUB_PAGES_BASE ?? '';
if (pagesBase && (!pagesBase.startsWith('/') || pagesBase.endsWith('/'))) {
	throw new Error('GITHUB_PAGES_BASE must start with / and must not end with /');
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			paths: { base: pagesBase as '' | `/${string}` }
		})
	]
});
