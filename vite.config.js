import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Set the base to the repository name so that the app works when deployed to GitHub Pages.
  // Replace 'vocab-cards' with your repository name if different.
  base: '/vocab-cards/',
});