// Personal fork: an in-page timeline for qa-blocks-compare.mjs --frame-eval
// (a function's source, run in the page as the load frames start and at
// each frame). It watches every frame after it is installed and answers,
// in performance.now() ms: when the app's splash went, when the Blocks
// tiles were first drawn, the box the plan named and the tileset drawn and
// pending (blocksTiles.js), and each gap after the drawn tileset first
// covered the view when it did not (blocksTiles.js coversView, on Cesium's
// own tiles). A page load at a Baltimore street (2026-10-30): before the
// box switch waited for its new tileset, gaps of 1.4 to 1.8 s; after, none.
() => {
  const scene = window.__godsEyeView?.viewer?.scene;
  if (!scene?.postRender) return 'no scene';
  const now = () => Math.round(performance.now());
  if (!window.__gevTimeline) {
    const t = (window.__gevTimeline = {
      installedAt: now(),
      events: {},
      frames: 0,
      boxes: [],
      shown: [],
      gaps: [],
    });
    const mark = (name) => {
      if (t.events[name] === undefined) t.events[name] = now();
    };
    const splashGone = () => {
      const cover = document.getElementById('loading-screen');
      if (!cover) return true;
      const style = getComputedStyle(cover);
      return (
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        Number(style.opacity) === 0
      );
    };
    if (splashGone()) t.splashGoneBeforeInstall = true;
    const tail = (url) =>
      url ? String(url).split('/').slice(-2).join('/') : null;
    // coversView: every visible tile at the first level with content in.
    const ready = (tile) => {
      if (tile.hasRenderableContent) return Boolean(tile.contentAvailable);
      if (!tile.children?.length) return !tile.hasTilesetContent;
      return tile.children.filter((child) => child.isVisible).every(ready);
    };
    let lastFrameAt = null;
    scene.postRender.addEventListener(() => {
      t.frames++;
      if (splashGone()) mark('splashGone');
      const state = window.__gevBlocksProbe?.tiles?.getState?.();
      if (state?.tilesSelected > 0) mark('tilesDrawn');
      const box = state?.tiles?.box ?? null;
      if (t.boxes.at(-1)?.[1] !== box) t.boxes.push([now(), box]);
      const shown = `${tail(state?.shown)} | ${tail(state?.pending)}`;
      if (t.shown.at(-1)?.[1] !== shown) t.shown.push([now(), shown]);
      let drawn = null;
      for (let i = 0; i < scene.primitives.length; i++) {
        const each = scene.primitives.get(i);
        if (each?.isCesium3DTileset && each.show) drawn = each;
      }
      const covers = Boolean(drawn?.root?.isVisible && ready(drawn.root));
      if (covers) mark('covers');
      else if (t.events.covers !== undefined) {
        const last = t.gaps.at(-1);
        if (last && last.to === lastFrameAt) last.to = now();
        else t.gaps.push({ from: now(), to: now(), shown });
      }
      lastFrameAt = now();
    });
  }
  const t = window.__gevTimeline;
  return { now: now(), ...t, events: { ...t.events } };
};
