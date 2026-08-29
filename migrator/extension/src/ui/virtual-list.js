// Minimal windowed list virtualization: renders only the rows in (or near)
// the viewport, regardless of how many thousand items exist. No framework,
// no build step — just a spacer for scrollbar height plus an absolutely
// positioned window of real rows that shifts on scroll.

export class VirtualList {
  constructor(container, { rowHeight, renderRow, overscan = 8 }) {
    this.container = container;
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.overscan = overscan;
    this.items = [];
    this._raf = null;

    container.classList.add("vlist");
    container.innerHTML = "";
    this.spacer = document.createElement("div");
    this.spacer.className = "vlist-spacer";
    this.viewport = document.createElement("div");
    this.viewport.className = "vlist-viewport";
    container.appendChild(this.spacer);
    container.appendChild(this.viewport);

    this._onScroll = () => this._scheduleRender();
    container.addEventListener("scroll", this._onScroll);
    this._onResize = () => this._scheduleRender();
    window.addEventListener("resize", this._onResize);
  }

  setItems(items) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    this.container.scrollTop = 0;
    this._render();
  }

  refresh() {
    this._render();
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  _render() {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
    const visibleCount = Math.ceil(viewportHeight / this.rowHeight) + this.overscan * 2;
    const end = Math.min(this.items.length, start + visibleCount);

    this.viewport.style.transform = `translateY(${start * this.rowHeight}px)`;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.renderRow(this.items[i], i);
      row.style.height = `${this.rowHeight}px`;
      frag.appendChild(row);
    }
    this.viewport.replaceChildren(frag);
  }

  destroy() {
    this.container.removeEventListener("scroll", this._onScroll);
    window.removeEventListener("resize", this._onResize);
  }
}
