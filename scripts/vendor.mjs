// Copies browser modules from dependencies into public/vendor so the static
// preview page can load them. Runs after `npm install` / `npm ci`.
import { copyFileSync, mkdirSync } from 'node:fs';

const target = new URL('../public/vendor/', import.meta.url);
mkdirSync(target, { recursive: true });
// G2 firmware font metrics (MIT, Even Realities).
copyFileSync(new URL('../node_modules/@evenrealities/pretext/dist/font_measure.js', import.meta.url), new URL('pretext.js', target));
