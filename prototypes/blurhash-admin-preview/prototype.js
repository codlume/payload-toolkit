const variants = [
  { key: "A", name: "Inline field", bounds: [144, 96] },
  { key: "B", name: "Preview panel", bounds: [288, 180] },
  { key: "C", name: "Metadata row", bounds: [80, 50] },
];

const collections = {
  media: {
    name: "Media",
    filename: "mountain-reflection.jpg",
    dimensions: [2400, 1500],
    alt: "Mountain ridge reflected in a still lake",
    palette: "landscape",
  },
  articles: {
    name: "Article images",
    filename: "editorial-portrait.jpg",
    dimensions: [1200, 1800],
    alt: "Editorial portrait in warm window light",
    palette: "portrait",
  },
};

const states = {
  ready: {
    label: "Generated",
    value: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    status: "BlurHash generated from the current image.",
    previewLabel: "",
  },
  empty: {
    label: "No value",
    value: "",
    status: "No BlurHash is available for this image.",
    previewLabel: "No preview",
  },
  invalid: {
    label: "Invalid value",
    value: "not-a-valid-blurhash",
    status: "The stored BlurHash could not be decoded. Its original value is preserved.",
    previewLabel: "Preview unavailable",
  },
};

const variantHost = document.querySelector("#variant-host");
const variantLabel = document.querySelector("#variant-label");
const collectionControl = document.querySelector("#collection-control");

const normalizeParam = (key, values, fallback) => {
  const candidate = new URL(window.location.href).searchParams.get(key);
  return values.includes(candidate) ? candidate : fallback;
};

const currentContext = () => {
  const variantKey = normalizeParam(
    "variant",
    variants.map(({ key }) => key),
    "A",
  );
  const stateKey = normalizeParam("state", Object.keys(states), "ready");
  const collectionKey = normalizeParam("collection", Object.keys(collections), "media");

  return {
    variant: variants.find(({ key }) => key === variantKey),
    stateKey,
    state: states[stateKey],
    collectionKey,
    collection: collections[collectionKey],
  };
};

const setParam = (key, value) => {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState({}, "", url);
  render();
};

const fitWithin = ([sourceWidth, sourceHeight], [maxWidth, maxHeight]) => {
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return [Math.round(sourceWidth * scale), Math.round(sourceHeight * scale)];
};

const previewMarkup = ({ collection, state, variant }) => {
  const [renderedWidth, renderedHeight] = fitWithin(collection.dimensions, variant.bounds);
  const style = `width: ${renderedWidth}px; height: ${renderedHeight}px`;

  if (state.value && !state.previewLabel) {
    const ratio = collection.dimensions[0] / collection.dimensions[1];
    const canvasWidth = ratio >= 1 ? 32 : Math.max(12, Math.round(32 * ratio));
    const canvasHeight = ratio >= 1 ? Math.max(12, Math.round(32 / ratio)) : 32;

    return `
      <div class="preview-surface" style="${style}" aria-hidden="true">
        <canvas
          width="${canvasWidth}"
          height="${canvasHeight}"
          data-palette="${collection.palette}"
          tabindex="-1"
        ></canvas>
      </div>
    `;
  }

  return `
    <div class="preview-surface" style="${style}" aria-hidden="true">
      <span>${state.previewLabel}</span>
    </div>
  `;
};

const fieldHeader = ({ stateKey, state }) => `
  <div class="field-label-row">
    <span class="field-label">BlurHash</span>
    <span class="state-tag" data-state="${stateKey}">${state.label}</span>
  </div>
`;

const valueField = ({ stateKey, state, suffix }) => `
  <label class="admin-field" for="blurhash-value-${suffix}">
    <span>Read-only value</span>
    <input
      id="blurhash-value-${suffix}"
      class="hash-input"
      type="text"
      value="${state.value}"
      placeholder="No value"
      readonly
      aria-describedby="blurhash-help-${suffix} blurhash-status-${suffix}"
    />
  </label>
  <p id="blurhash-status-${suffix}" class="field-status" data-state="${stateKey}">
    ${state.status}
  </p>
`;

const helpMarkup = (suffix) => `
  <p id="blurhash-help-${suffix}" class="field-help">
    A compact placeholder generated from the current image. The value is managed automatically.
  </p>
`;

const contractNote = `
  <p class="contract-note">
    <strong>Prototype constraint.</strong>
    Unsupported, skipped, and failed generation all store <code>null</code>, so Admin presents one
    neutral no-value state. This note is not proposed production copy.
  </p>
`;

const VariantA = (context) => `
  <section class="blurhash-field variant-a" aria-labelledby="variant-a-label">
    <div class="field-label-row">
      <span id="variant-a-label" class="field-label">BlurHash</span>
      <span class="read-only-tag">Read only</span>
    </div>
    <div class="inline-field">
      ${previewMarkup(context)}
      <div class="field-copy">
        <span class="state-tag" data-state="${context.stateKey}">${context.state.label}</span>
        ${valueField({ ...context, suffix: "a" })}
        ${helpMarkup("a")}
      </div>
    </div>
    ${contractNote}
  </section>
`;

const VariantB = (context) => `
  <section class="blurhash-field variant-b" aria-labelledby="variant-b-label">
    ${fieldHeader(context).replace('class="field-label"', 'id="variant-b-label" class="field-label"')}
    <div class="preview-panel">
      ${previewMarkup(context)}
      <div class="panel-copy">
        ${helpMarkup("b")}
        ${valueField({ ...context, suffix: "b" })}
      </div>
    </div>
    ${contractNote}
  </section>
`;

const VariantC = (context) => `
  <section class="blurhash-field variant-c" aria-labelledby="variant-c-label">
    <div class="metadata-row">
      <div class="metadata-label">
        <span id="variant-c-label" class="field-label">BlurHash</span>
        <span class="read-only-tag">Read only</span>
      </div>
      <div class="metadata-value">
        <label class="admin-field" for="blurhash-value-c">
          <span class="state-tag" data-state="${context.stateKey}">${context.state.label}</span>
          <input
            id="blurhash-value-c"
            class="hash-input"
            type="text"
            value="${context.state.value}"
            placeholder="No value"
            readonly
            aria-describedby="blurhash-help-c blurhash-status-c"
          />
        </label>
        <p id="blurhash-status-c" class="field-status" data-state="${context.stateKey}">
          ${context.state.status}
        </p>
      </div>
      ${previewMarkup(context)}
    </div>
    ${helpMarkup("c")}
    ${contractNote}
  </section>
`;

const renderers = { A: VariantA, B: VariantB, C: VariantC };

const paintPreviews = () => {
  for (const canvas of document.querySelectorAll("canvas[data-palette]")) {
    const context = canvas.getContext("2d");
    const isPortrait = canvas.dataset.palette === "portrait";
    const base = context.createLinearGradient(0, 0, canvas.width, canvas.height);

    if (isPortrait) {
      base.addColorStop(0, "#342e50");
      base.addColorStop(0.52, "#b97469");
      base.addColorStop(1, "#e5c4a0");
    } else {
      base.addColorStop(0, "#263e52");
      base.addColorStop(0.48, "#718f91");
      base.addColorStop(1, "#d3b27c");
    }

    context.fillStyle = base;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const glow = context.createRadialGradient(
      canvas.width * 0.72,
      canvas.height * 0.25,
      0,
      canvas.width * 0.72,
      canvas.height * 0.25,
      canvas.width * 0.72,
    );
    glow.addColorStop(0, isPortrait ? "rgb(255 216 178 / 72%)" : "rgb(236 208 143 / 78%)");
    glow.addColorStop(1, "rgb(255 255 255 / 0%)");
    context.fillStyle = glow;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
};

const render = () => {
  const context = currentContext();
  variantHost.innerHTML = renderers[context.variant.key](context);
  variantLabel.textContent = `${context.variant.key} — ${context.variant.name}`;

  collectionControl.value = context.collectionKey;
  document.querySelector(`input[name="state"][value="${context.stateKey}"]`).checked = true;
  document.querySelector("#collection-name").textContent = context.collection.name;
  document.querySelector("#document-title").textContent = context.collection.filename;
  document.querySelector("#filename").value = context.collection.filename;
  document.querySelector("#dimensions").value =
    `${context.collection.dimensions[0]} × ${context.collection.dimensions[1]} px`;
  document.querySelector("#alt-text").value = context.collection.alt;

  paintPreviews();
};

const cycleVariant = (direction) => {
  const { variant } = currentContext();
  const currentIndex = variants.findIndex(({ key }) => key === variant.key);
  const nextIndex = (currentIndex + direction + variants.length) % variants.length;
  setParam("variant", variants[nextIndex].key);
};

document.querySelector("#previous-variant").addEventListener("click", () => cycleVariant(-1));
document.querySelector("#next-variant").addEventListener("click", () => cycleVariant(1));
collectionControl.addEventListener("change", (event) => setParam("collection", event.target.value));

for (const control of document.querySelectorAll('input[name="state"]')) {
  control.addEventListener("change", (event) => setParam("state", event.target.value));
}

window.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  if (event.target.closest("input, textarea, select, button, [contenteditable]")) return;
  event.preventDefault();
  cycleVariant(event.key === "ArrowLeft" ? -1 : 1);
});

window.addEventListener("popstate", render);
render();
