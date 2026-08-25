/*
 * Behaviour for the landing page: the tab pattern and the copy buttons.
 *
 * From `site/main.js`, less the two things the build now does — highlighting the samples and
 * writing in the benchmark figures. What is left is the part that cannot be done ahead of time,
 * because it is a response to somebody doing something.
 */

/**
 * The ARIA tabs pattern: one tab in the tab order at a time, arrows and Home/End to move between
 * them, and selection following focus — the panels here are static text, so there is nothing to
 * be gained by making a reader press Enter to see one.
 */
function setUpTabs() {
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    if (tabs.length === 0) continue;

    // Panels are visible in the markup so the samples are all readable without this script;
    // hiding the unselected ones is the first thing it does.
    const selected = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    select(tabs, selected < 0 ? 0 : selected, false);

    list.addEventListener("click", (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab === null || !tabs.includes(tab)) return;
      select(tabs, tabs.indexOf(tab), false);
    });

    list.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(document.activeElement);
      if (current < 0) return;
      // A horizontal tablist that wraps onto a second line is still one sequence, so Up/Down are
      // taken as well as Left/Right rather than being left to scroll the page.
      const move = {
        ArrowRight: current + 1,
        ArrowDown: current + 1,
        ArrowLeft: current - 1,
        ArrowUp: current - 1,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (move === undefined) return;
      event.preventDefault();
      select(tabs, (move + tabs.length) % tabs.length, true);
    });
  }
}

/** Selects one tab, moves the roving tabindex to it, and shows only its panel. */
function select(tabs, index, focus) {
  tabs.forEach((tab, position) => {
    const isSelected = position === index;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    if (panel !== null) panel.hidden = !isSelected;
  });
  if (focus) tabs[index].focus();
}

/**
 * Copy, with a fallback that is honest about failing. `navigator.clipboard` needs a secure
 * context, and a page opened from disk is not one in every browser — so when the write is
 * refused the sample is selected instead and the button says what to press.
 */
function setUpCopyButtons() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    const code = button.closest("figure")?.querySelector("pre code");
    if (code === null || code === undefined) continue;

    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        say(button, "copied");
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        say(button, "selected — press ctrl/⌘+C");
      }
    });
  }
}

/** Says something on a button for a moment, then puts its label back. */
function say(button, message) {
  const previous = button.dataset["label"] ?? button.textContent;
  button.dataset["label"] = previous;
  button.textContent = message;
  clearTimeout(Number(button.dataset["timer"]));
  button.dataset["timer"] = String(
    setTimeout(() => {
      button.textContent = previous;
    }, 2000),
  );
}

setUpTabs();
setUpCopyButtons();
