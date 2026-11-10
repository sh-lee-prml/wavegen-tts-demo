# WaveGen - Zero-shot TTS Benchmark

A static comparison page with **100 English listening samples across 11 models**.

The benchmark table retains the original results over **1,088 Seed-TTS EN sentences**. The listening library contains the same 100 selected sentences for every model. Sample metrics, ASR transcripts, reference prompts, waveforms, and WAV files are copied from the full demo without re-evaluation or audio conversion.

WaveGen-Flash uses the **48k EMA, MelTemp0, NFE 4** results. Model names, order, and size badges match the full demo.

## Publish on GitHub Pages

Upload the **extracted files**, not the ZIP archive. Keep `index.html`, `catalog.js`, `audio/`, and `samples/` at the repository root. Include the hidden `.nojekyll` and `.gitattributes` files.

1. Create an empty public GitHub repository, for example `wavegen-tts-demo`. Leave the initial README, license, and gitignore options unselected.
2. Open a terminal in this extracted folder and replace the two placeholders below:

   ```powershell
   git init
   git add .
   git commit -m "Add WaveGen TTS benchmark demo"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
   git push -u origin main
   ```

3. In the repository, open **Settings → Pages → Build and deployment**.
4. Select **Deploy from a branch**, branch **main**, folder **/(root)**, then **Save**.
5. Open the site URL shown in Pages settings after deployment finishes. A project site normally uses `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

No build command, Python environment, GPU, or backend service is required on GitHub Pages. Publishing from a branch and the root directory is supported by [GitHub's Pages configuration guide](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Local preview

From this folder:

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8000/`. Use HTTP or HTTPS; opening `index.html` directly with `file://` cannot load the sample JSON files.

## Included files

- 100 selected sentences and all 11 model outputs per sentence.
- 1,193 original WAV files, including 93 distinct reference prompts.
- 291.8 MB of audio; largest individual file: 0.645 MiB.
- The static page, styles, scripts, catalog, and 100 sample detail files.
- `release-manifest.json` with selection details and file fingerprints.

The 100 IDs were chosen deterministically by SHA-256 ranking of `"wavegen-github-pages-v1\0" + sample.id`, then listed in original dataset order. The selection does not use scores or audio quality. Every normal visit starts with a random sample from this fixed set.

The full 1,088-sentence benchmark scores stay unchanged. **Benchmark · 1,088 samples** uses those aggregate scores; **Current sample** uses the selected sentence's scores. The audio library and per-model run counts refer to the 100 included examples.

The page loads a small catalog first, requests sample detail JSON on selection, and fetches WAV audio only after Play. Browser caches and saved view preferences are scoped to the site's directory, so separate repositories do not share the same listening state.

## Repository size

This export is below GitHub Pages' **1 GB** site limit, and each included file is below GitHub's **100 MiB** file limit. The ZIP is a transfer artifact outside the repository; do not commit it. See [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) and [GitHub file limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

The package contains the selected public demo assets, without local inference environments, checkpoints, private metadata, or retired audio versions.
