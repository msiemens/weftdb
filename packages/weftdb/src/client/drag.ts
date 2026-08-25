export class DragFrozenList<T> {
  #dragging = false;
  #visible: readonly T[] = [];
  #pending: readonly T[] | undefined;

  constructor(initial: readonly T[] = []) {
    this.#visible = initial;
  }

  startDrag(): readonly T[] {
    this.#dragging = true;
    return this.#visible;
  }

  update(next: readonly T[]): readonly T[] {
    if (this.#dragging) {
      this.#pending = next;
      return this.#visible;
    }
    this.#visible = next;
    return this.#visible;
  }

  drop(): readonly T[] {
    this.#dragging = false;
    if (this.#pending !== undefined) {
      this.#visible = this.#pending;
      this.#pending = undefined;
    }
    return this.#visible;
  }
}
