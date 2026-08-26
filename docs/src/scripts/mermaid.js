/*
 * Draws every diagram `remark-mermaid.mjs` left on the page, in the loom's colours, and redraws
 * them when the reader flips the theme.
 *
 * This module is only ever reached through a dynamic import from the guard in
 * `components/Head.astro`, so the renderer — which is a megabyte of parser and layout — is a chunk
 * of its own that a page without a diagram never asks for.
 *
 * The colours are the tokens in `styles/loom.css`, read off the page rather than restated here:
 * there is one palette and this is not allowed to become a second. They cannot be read straight
 * out of the custom properties, because a custom property computes to the text it was written as
 * and every token is a `light-dark()` pair — so a throwaway element is given `color: var(--token)`
 * and its computed `color` is the resolved value. That also means the theme is settled by the same
 * rules as everything else on the page, whether the reader chose it or the operating system did.
 *
 * Mermaid holds the resolved colours from `initialize`, so following the toggle means initializing
 * again and redrawing. The source for that is kept here, in `sources`, because drawing replaces
 * the element's contents and the second redraw would otherwise have nothing to read.
 */

import mermaid from "mermaid";

/** @type {Map<HTMLElement, string>} */
const sources = new Map();
let drawn = 0;
/** Drawing is serialized: mermaid keeps one global configuration and one scratch element. */
let queue = Promise.resolve();

export function mountDiagrams() {
  for (const element of document.querySelectorAll(".mermaid-diagram")) {
    const source = element.dataset.mermaid;
    if (source !== undefined && source.length > 0) sources.set(element, source);
  }
  if (sources.size === 0) return;

  draw();

  // Both halves of "the theme changed": the toggle stamps `data-theme` on the root, and a reader
  // who has left it on the system's setting changes theme without anything on the page moving.
  new MutationObserver(draw).observe(document.documentElement, { attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());
}

function draw() {
  queue = queue.then(async () => {
    mermaid.initialize(configuration());
    for (const [element, source] of sources) {
      // A fresh id per drawing: mermaid scopes the stylesheet it puts inside the SVG by this id,
      // and a redraw that reused it would leave two rules claiming the same selector.
      const id = `mermaid-${(drawn += 1)}`;
      try {
        const { svg } = await mermaid.render(id, source);
        element.innerHTML = svg;
        element.removeAttribute("data-mermaid-error");
        widen(element);
      } catch (error) {
        // `suppressErrorRendering` keeps mermaid from putting its own error diagram on the page, so
        // a diagram that will not parse says so where it stands instead of half-drawing.
        element.setAttribute("data-mermaid-error", "");
        element.textContent = `${error}`;
      }
    }
  });
  return queue;
}

/**
 * Mermaid fits a diagram to its container by giving the SVG `width: 100%` and its natural width as
 * a `max-width`, which shrinks a wide one until it is unreadable. Swapping the two makes the SVG
 * its own size and leaves the overflow to the scroll box it sits in, the way a wide table is
 * handled.
 *
 * @param {HTMLElement} element
 */
function widen(element) {
  const svg = element.querySelector("svg");
  if (svg === null) return;
  const natural = svg.style.maxWidth;
  if (natural === "") return;
  svg.style.width = natural;
  svg.style.maxWidth = "none";
}

function configuration() {
  const colors = resolve([
    "--surface",
    "--sunken",
    "--rule",
    "--rule-strong",
    "--ink",
    "--ink-2",
    "--ink-3",
    "--accent",
    "--accent-wash",
  ]);
  const root = getComputedStyle(document.documentElement);

  return {
    startOnLoad: false,
    suppressErrorRendering: true,
    fontFamily: root.getPropertyValue("--mono"),
    theme: "base",
    themeVariables: {
      // Mermaid derives whatever is left unset from what is set, and which direction it moves a
      // colour depends on this. It is taken from the ground rather than from `data-theme` so it is
      // right however the reader arrived at the theme.
      darkMode: dark(colors["--surface"]),
      fontFamily: root.getPropertyValue("--mono"),
      fontSize: "13px",

      background: colors["--surface"],
      // A node is the same recess as a code block, inside the same hairline.
      primaryColor: colors["--sunken"],
      primaryBorderColor: colors["--rule-strong"],
      primaryTextColor: colors["--ink"],
      secondaryColor: colors["--accent-wash"],
      secondaryBorderColor: colors["--rule-strong"],
      secondaryTextColor: colors["--ink"],
      tertiaryColor: colors["--surface"],
      tertiaryBorderColor: colors["--rule"],
      tertiaryTextColor: colors["--ink"],

      mainBkg: colors["--sunken"],
      nodeBorder: colors["--rule-strong"],
      nodeTextColor: colors["--ink"],
      titleColor: colors["--ink"],
      textColor: colors["--ink"],
      // Edges are structure, not emphasis: the quietest ink still cleared for a line.
      lineColor: colors["--ink-3"],
      // A label sits on the panel, not on the edge it interrupts.
      edgeLabelBackground: colors["--surface"],
      clusterBkg: colors["--surface"],
      clusterBorder: colors["--rule"],

      // A note is the aside: the accent wash behind the accent's own edge.
      noteBkgColor: colors["--accent-wash"],
      noteBorderColor: colors["--accent"],
      noteTextColor: colors["--ink"],

      actorBkg: colors["--sunken"],
      actorBorder: colors["--rule-strong"],
      actorTextColor: colors["--ink"],
      actorLineColor: colors["--rule-strong"],
      signalColor: colors["--ink"],
      signalTextColor: colors["--ink"],
      // The `alt`/`loop` frame and its label chip.
      labelBoxBkgColor: colors["--sunken"],
      labelBoxBorderColor: colors["--rule-strong"],
      labelTextColor: colors["--ink"],
      loopTextColor: colors["--ink"],
      altSectionBkgColor: colors["--sunken"],
      activationBkgColor: colors["--accent-wash"],
      activationBorderColor: colors["--accent"],
      // The autonumber disc is drawn in `lineColor`, so its digits need the ground back.
      sequenceNumberColor: colors["--surface"],
    },
  };
}

/**
 * The tokens, resolved to the colours they currently stand for.
 *
 * @param {readonly string[]} names
 * @returns {Record<string, string>}
 */
function resolve(names) {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);

  /** @type {Record<string, string>} */
  const colors = {};
  for (const name of names) {
    probe.style.color = `var(${name})`;
    colors[name] = getComputedStyle(probe).color;
  }

  probe.remove();
  return colors;
}

/** Whether a resolved `rgb(...)` is a dark ground. @param {string} color */
function dark(color) {
  const [red = 255, green = 255, blue = 255] = [...color.matchAll(/\d+(?:\.\d+)?/gu)].map(Number);
  // Rec. 601 luma, which is enough to tell a ground apart from its opposite.
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
}
