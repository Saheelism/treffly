import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Writes dist/sw.js with the list of app files to keep offline. The version changes whenever the
// app or the data change, so visitors get fresh files after every deploy.
function serviceWorker(): Plugin {
  return {
    name: 'treffly-sw',
    apply: 'build',
    closeBundle() {
      const dist = path.resolve('dist');
      const list = (dir: string): string[] => fs.readdirSync(path.join(dist, dir), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name)) : [path.join(dir, e.name).split(path.sep).join('/')]));
      const shell = ['./', ...list('assets'), ...list('icons'), 'manifest.webmanifest'];
      const data = ['network.json', 'geo.json', 'venues.json'].map((f) => `data/${f}`).filter((f) => fs.existsSync(path.join(dist, f)));
      const hash = crypto.createHash('sha256');
      for (const f of [...shell.slice(1), ...data, 'index.html']) hash.update(f).update(fs.readFileSync(path.join(dist, f)));
      for (const f of fs.existsSync(path.join(dist, 'data')) ? fs.readdirSync(path.join(dist, 'data')).filter((f) => f.endsWith('.bin')) : []) hash.update(fs.readFileSync(path.join(dist, 'data', f)));
      const sw = fs.readFileSync(path.resolve('pipeline/sw-template.js'), 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__SHELL__', JSON.stringify(shell))
        .replace('__DATA__', JSON.stringify(data));
      fs.writeFileSync(path.join(dist, 'sw.js'), sw);
    },
  };
}

export default defineConfig({ base: './', build: { chunkSizeWarningLimit: 1500 }, plugins: [serviceWorker()] });
