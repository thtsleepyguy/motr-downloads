async function showLatestRelease() {
  const repository = 'thtsleepyguy/motr-downloads';
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return;
    const release = await response.json();
    const apk = release.assets?.find(asset => asset.name === 'MOTR.apk' && asset.state === 'uploaded');
    if (!apk || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
      !Number.isFinite(apk.size) || apk.size <= 0) return;

    const version = release.tag_name.slice(1);
    const megabytes = Math.round(apk.size / 1_000_000);
    for (const element of document.querySelectorAll('[data-release-spec]')) {
      element.textContent = `Android beta ${version} · ${megabytes} MB · Android 7.0+`;
    }
    const notes = document.querySelector('[data-release-notes]');
    if (notes) notes.href = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
  } catch {
    // The download and release archive links work without the metadata request.
  }
}

void showLatestRelease();
