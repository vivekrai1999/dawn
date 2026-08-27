/*
  <bouquet-builder> — the interactive Canvas bouquet composer for
  sections/bouquet-builder.liquid.

  ── The one rule everything else follows ──────────────────────────────────────

    Shopify defines what can be purchased. The builder defines how those
    purchasable items are arranged.

  So: the Canvas renders the state, it is never the state. Interaction writes to
  the store, the store notifies its subscribers, and the subscribers — Canvas,
  picker, summary — redraw themselves from it. There is no path back the other
  way, and nothing outside BouquetCatalog knows the shape Shopify hands us.

  ── Custom-element contract, as everywhere else in this theme ─────────────────

  Nodes are resolved from `this`, never from `document`; nothing is written to
  `window`; everything bound is released in disconnectedCallback. The element's
  own lifecycle callbacks fire when the Theme Editor swaps a section, so there
  are deliberately no `shopify:section:load` / `unload` listeners — they would
  be a second teardown path for the same job. Any number of these can share a
  page.

  ── Choose your flowers; we arrange them ──────────────────────────────────────

  The customer's decision is *which* flowers and *how many* — never where each
  one sits. So:

    catalog + items + seed  ──►  BouquetLayoutEngine  ──►  transforms  ──►  Canvas

  Instances carry only what they are. Position, scale, rotation and layer are
  derived on every render from the item list and a single seed, and never
  written back. Two consequences matter:

  1. Shuffle is one number. New seed, same products, same quantities, same
     price, a completely new arrangement.
  2. Nothing else can ever disturb the bouquet. A resize, a category filter, a
     price update, the cart drawer opening — none of them touch the seed, and
     the engine is pure, so the flowers do not move.

  The Canvas offers exactly one interaction: hover to see which stem is under
  the pointer, click to take it out. No drag, no rotate, no scale, no handles.
  The customer is a shopper, not a graphic designer.

  ── Why there is no Canvas library ────────────────────────────────────────────

  Weighed before writing a line of BouquetRenderer, because a storefront pays
  for every kilobyte in a way an app does not.

  What the feature actually needs is: draw images under a transform, and hit
  test a pointer against them. Against CanvasRenderingContext2D that is the
  handful of methods below. Konva would have given us a scene graph, an event
  system and drag/drop for ~150KB, nearly all of it for the editing this
  deliberately does not do. Fabric.js is built for design editors and is more
  object model than we have objects. PixiJS is a WebGL renderer for thousands
  of sprites in a game loop.

  None of them earn their weight here, and the deciding factor is that the theme
  is otherwise dependency-free on the storefront. Everything Canvas-shaped is
  behind BouquetRenderer — nothing else in this file knows a Canvas exists, so
  swapping it is one class.

  ── Cart ──────────────────────────────────────────────────────────────────────

  No cart logic is reimplemented. BouquetCart follows the conventions in
  assets/product-form.js: fetchConfig, the route object, the `sections` handoff,
  PUB_SUB_EVENTS.cartUpdate, and whichever of <cart-drawer> / <cart-notification>
  the merchant has configured renders itself. It is the only place that knows
  the bouquet becomes plain variant lines, so the day this store gets a Cart
  Transform function and the bouquet becomes one bundle line, this is the file
  that changes and nothing else moves.

  ── Money ─────────────────────────────────────────────────────────────────────

  No currency is formatted from knowledge held in this file. Unit prices arrive
  pre-formatted from Liquid; derived sums are rendered through the shop's own
  money_format string, which also arrives from Liquid. No currency symbol
  appears in this source.
*/
(() => {
  'use strict';

  if (customElements.get('bouquet-builder')) return;

  /* ------------------------------------------------------------------ Money */

  const MONEY_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/;

  function groupDigits(cents, precision, thousands, decimal) {
    if (!Number.isFinite(cents)) return '0';
    const fixed = (cents / 100).toFixed(precision);
    const parts = fixed.split('.');
    const whole = parts[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, `$1${thousands}`);
    return parts[1] ? whole + decimal + parts[1] : whole;
  }

  /*
    Shopify's own money_format convention. The template — symbol, placement and
    separator style — comes from the shop, so this only ever fills in a number.
  */
  function formatMoney(cents, format) {
    const template = format || '{{amount}}';
    const match = template.match(MONEY_PLACEHOLDER);
    let value;

    switch (match && match[1]) {
      case 'amount_no_decimals':
        value = groupDigits(cents, 0, ',', '.');
        break;
      case 'amount_with_comma_separator':
        value = groupDigits(cents, 2, '.', ',');
        break;
      case 'amount_no_decimals_with_comma_separator':
        value = groupDigits(cents, 0, '.', ',');
        break;
      case 'amount_with_apostrophe_separator':
        value = groupDigits(cents, 2, "'", '.');
        break;
      case 'amount_no_decimals_with_space_separator':
        value = groupDigits(cents, 0, ' ', ',');
        break;
      case 'amount_with_space_separator':
        value = groupDigits(cents, 2, ' ', ',');
        break;
      case 'amount_with_period_and_space_separator':
        value = groupDigits(cents, 2, ' ', '.');
        break;
      default:
        value = groupDigits(cents, 2, ',', '.');
    }

    return template.replace(MONEY_PLACEHOLDER, value);
  }

  /* ------------------------------------------------------------- Small tools */

  const FLASH_MS = 4000;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const prefersReducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ================================================================ Catalog */

  /*
    The normalised product lookup, and the only thing that has ever seen the
    shape Liquid emits. Everything downstream reads plain fields off these
    objects — no title parsing, no Shopify-specific structure, no inference.
  */
  class BouquetCatalog {
    static fromScript(node) {
      if (!node) return new BouquetCatalog({});
      try {
        return new BouquetCatalog(JSON.parse(node.textContent));
      } catch (error) {
        console.warn('bouquet-builder: the catalog could not be read.', error);
        return new BouquetCatalog({});
      }
    }

    constructor(payload) {
      const source = payload && typeof payload === 'object' ? payload : {};

      this.moneyFormat = typeof source.moneyFormat === 'string' ? source.moneyFormat : '{{amount}}';
      this.items = Array.isArray(source.items) ? source.items.filter((item) => item && item.id) : [];
      this.index = new Map(this.items.map((item) => [item.id, item]));
    }

    get size() {
      return this.items.length;
    }

    get isEmpty() {
      return this.items.length === 0;
    }

    get(id) {
      return this.index.get(id) || null;
    }

    money(cents) {
      return formatMoney(cents, this.moneyFormat);
    }

    /* The categories the merchant actually used, in the order they appear. */
    categories() {
      const seen = [];
      this.items.forEach((item) => {
        if (item.category && !seen.includes(item.category)) seen.push(item.category);
      });
      return seen;
    }
  }

  /* ================================================================== Store */

  const HISTORY_LIMIT = 40;

  /*
    The bouquet is a list of instances, a seed, and whichever instance is
    selected.

    An instance holds what it is, and — once the customer has moved, turned,
    resized or restacked it — an `override` holding only the fields they
    changed. Everything they have not touched still comes from
    BouquetLayoutEngine, so a new flower always lands somewhere sensible and
    only deliberate edits persist. Shuffle clears the overrides, because
    re-arranging that kept half the bouquet pinned would not be a re-arrangement.

    Three roses on the Canvas are three instances and one cart line of three.
  */
  function reduce(state, action) {
    const keep = { seed: state.seed, selectedId: state.selectedId };

    /* Merge a partial transform onto one instance, leaving the rest alone. */
    const amend = (instanceId, changes) => {
      let touched = false;
      const items = state.items.map((item) => {
        if (item.instanceId !== instanceId) return item;
        touched = true;
        return { ...item, override: { ...(item.override || {}), ...changes } };
      });
      return touched ? { ...keep, items } : state;
    };

    switch (action.type) {
      case 'add':
        return {
          ...keep,
          items: state.items.concat({ instanceId: action.instanceId, catalogId: action.catalogId }),
          selectedId: action.instanceId,
        };

      case 'remove': {
        const items = state.items.filter((item) => item.instanceId !== action.instanceId);
        if (items.length === state.items.length) return state;
        return { ...keep, items, selectedId: state.selectedId === action.instanceId ? null : state.selectedId };
      }

      case 'removeLastOf': {
        for (let i = state.items.length - 1; i >= 0; i -= 1) {
          if (state.items[i].catalogId === action.catalogId) {
            const items = state.items.slice();
            const [gone] = items.splice(i, 1);
            return { ...keep, items, selectedId: state.selectedId === gone.instanceId ? null : state.selectedId };
          }
        }
        return state;
      }

      case 'removeAllOf': {
        const items = state.items.filter((item) => item.catalogId !== action.catalogId);
        if (items.length === state.items.length) return state;
        const alive = items.some((item) => item.instanceId === state.selectedId);
        return { ...keep, items, selectedId: alive ? state.selectedId : null };
      }

      /* Dragging, turning and resizing all land here. */
      case 'place':
        return amend(action.instanceId, action.placement);

      /*
        Forward and back. The layer the engine chose is the starting point, so
        the first nudge has to be measured from wherever the piece actually sits
        rather than from zero.
      */
      case 'restack': {
        const current = state.items.find((item) => item.instanceId === action.instanceId);
        if (!current) return state;
        const from =
          current.override && Number.isFinite(current.override.layer) ? current.override.layer : action.baseLayer;
        return amend(action.instanceId, { layer: clamp(from + action.by, -50, 200) });
      }

      case 'select': {
        if (state.selectedId === action.instanceId) return state;
        const exists = action.instanceId === null || state.items.some((item) => item.instanceId === action.instanceId);
        return exists ? { ...keep, items: state.items, selectedId: action.instanceId } : state;
      }

      /*
        A new arrangement, and a clean slate: overrides are dropped so every
        flower takes the position the engine just chose for it.
      */
      case 'shuffle':
        return {
          items: state.items.map(({ instanceId, catalogId }) => ({ instanceId, catalogId })),
          seed: action.seed,
          selectedId: state.selectedId,
        };

      case 'reset':
        return state.items.length === 0 ? state : { items: [], seed: action.seed, selectedId: null };

      default:
        return state;
    }
  }

  const randomSeed = () => Math.floor(Math.random() * 0x7fffffff) + 1;

  class BouquetStore {
    constructor() {
      this.state = { items: [], seed: randomSeed(), selectedId: null };
      this.listeners = new Set();
      this.past = [];
      this.sequence = 0;
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    getState() {
      return this.state;
    }

    nextInstanceId() {
      this.sequence += 1;
      return `i${this.sequence}`;
    }

    /*
      A drag is one undoable step, not one per pointermove — so the caller takes
      a checkpoint when the gesture starts and dispatches with `history: false`
      while it runs.
    */
    checkpoint() {
      this.pushHistory(this.state);
    }

    pushHistory(snapshot) {
      this.past.push(snapshot);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }

    dispatch(action) {
      const next = reduce(this.state, action);
      if (next === this.state) return false;

      if (action.history !== false) this.pushHistory(this.state);

      this.state = next;
      this.notify(action.type);
      return true;
    }

    undo() {
      if (!this.past.length) return false;
      this.state = this.past.pop();
      this.notify('undo');
      return true;
    }

    get canUndo() {
      return this.past.length > 0;
    }

    notify(reason) {
      this.listeners.forEach((listener) => listener(this.state, reason));
    }

    destroy() {
      this.listeners.clear();
      this.past.length = 0;
    }
  }

  /* The total is derived on demand. Storing it would let it drift from truth. */
  function calculateTotal(state, catalog) {
    return state.items.reduce((sum, instance) => {
      const item = catalog.get(instance.catalogId);
      return item ? sum + item.price : sum;
    }, 0);
  }

  /* One line per variant, quantity from the instance count. */
  function deriveLines(state, catalog) {
    const order = [];
    const counts = new Map();

    state.items.forEach((instance) => {
      if (!counts.has(instance.catalogId)) {
        counts.set(instance.catalogId, 0);
        order.push(instance.catalogId);
      }
      counts.set(instance.catalogId, counts.get(instance.catalogId) + 1);
    });

    return order
      .map((catalogId) => {
        const item = catalog.get(catalogId);
        if (!item) return null;
        const quantity = counts.get(catalogId);
        return { item, quantity, subtotal: item.price * quantity };
      })
      .filter(Boolean);
  }

  function countOf(state, catalogId) {
    return state.items.reduce((n, item) => (item.catalogId === catalogId ? n + 1 : n), 0);
  }

  /* ================================================================= Layout */

  /*
    BouquetLayoutEngine — the composition system.

    Given the items in the bouquet and a seed, it returns a render transform for
    every one of them. It is pure: the same items and the same seed always
    produce the same arrangement, so a resize, a re-render, a price update or a
    cart drawer opening can never disturb the flowers. Only a new seed can.

    It knows nothing about crochet, or flowers, or this shop. It works on
    `role`, `scale` and `layer` — so a bouquet of anything else would need no
    changes here.

    The composition is built from rings rather than a hand-drawn table per
    count: a focal core, a secondary ring around it, and an outer ring of
    fillers and greenery. That way six stems and ten stems are the same
    composition at different densities, and a merchant raising the maximum does
    not need a new template written for them.
  */

  /* The golden angle: successive points never repeat an alignment. */
  const GOLDEN_ANGLE = 2.39996323;

  const ROLES = ['focal', 'secondary', 'filler', 'greenery', 'accent'];

  /*
    The role a product plays when the merchant has not said. Derived from the
    category they *did* set — never from the product's title.
  */
  const CATEGORY_ROLE = {
    flower: 'secondary',
    filler: 'filler',
    leaf: 'greenery',
    wrapper: 'accent',
    ribbon: 'accent',
    charm: 'accent',
  };

  /* Depth: greenery at the back, focal blooms at the front. */
  const ROLE_LAYER = { greenery: 10, filler: 20, secondary: 30, focal: 40, accent: 50 };

  /* Accessories sit outside the bouquet proper, so they get their own depths. */
  const ACCESSORY_LAYER = { wrapper: 0, ribbon: 55, charm: 60 };

  /*
    A wrap straddles the bouquet rather than sitting on one side of it: the
    backing sheet goes behind everything, the front flap in front of the
    flowers. The flower bands (10 to 40) fall between the two, so a bouquet is
    gathered into the cone by default — and Bring forward can push one bloom out
    past the flap, or Send back tuck it in again.
  */
  const WRAP_BACK_LAYER = 0;
  const WRAP_FRONT_LAYER = 50;

  /*
    The front flap hangs a little lower than the backing sheet, as it does on a
    real wrap — the paper folds forward and down over the stems. Sitting the two
    at the same height made the flap swallow the lowest blooms; dropping it
    opens the mouth of the cone so the bouquet shows through it.

    A fraction of the Canvas height, so it holds at any size.
  */
  const WRAP_FRONT_DROP = 0.055;

  /* Where a role is happy to sit when its own slot is taken. */
  const ROLE_FALLBACK = {
    focal: ['focal', 'secondary', 'filler', 'greenery'],
    secondary: ['secondary', 'focal', 'filler', 'greenery'],
    filler: ['filler', 'greenery', 'secondary', 'focal'],
    greenery: ['greenery', 'filler', 'secondary', 'focal'],
  };

  /* Size by role, before the product's own bouquet_scale is applied. */
  const ROLE_SCALE = {
    focal: [1.02, 1.14],
    secondary: [0.88, 1.0],
    filler: [0.66, 0.82],
    greenery: [0.8, 0.96],
  };

  const roleOf = (item) => {
    if (item.role && ROLES.includes(item.role)) return item.role;
    return CATEGORY_ROLE[item.category] || 'secondary';
  };

  const isAccessory = (item) => roleOf(item) === 'accent';

  /* A small, fast, well-distributed PRNG. Seeded, so shuffle is reproducible. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /*
    A random stream belonging to one thing rather than to a position in a queue.

    Everything the engine varies — how big a bloom is drawn, how far it is
    turned, how much a slot wobbles off its ideal point — used to be drawn from
    a single sequential stream shared by the whole bouquet. That made every
    value depend on how many draws had been taken before it, and the number of
    draws taken before the sizing pass is the number of stems. So adding one
    flower slid the entire remainder of the stream along by one, and every
    flower already on the canvas was re-sized by up to eight per cent and turned
    by up to six degrees — same seed, different bouquet, for no reason the
    customer could see beyond "I added a daisy and everything moved".

    Keying the stream to the thing's own name instead makes each stem's look its
    own business. Adding, removing or re-ordering cannot reach it, and a shuffle
    still changes everything because the seed is mixed in.
  */
  function streamFor(seed, name) {
    let hash = 0x811c9dc5;
    const text = String(name);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return mulberry32((hash ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  class BouquetLayoutEngine {
    constructor(options) {
      const settings = options || {};
      /* The bouquet head sits above centre, leaving the lower third for the wrap. */
      this.centre = { x: 0.5, y: settings.centreY || 0.38 };
      this.spread = settings.spread || 1;
    }

    /*
      How many slots each ring gets for a bouquet of n stems. The shape stays
      recognisable from three stems to a dozen: a small bright core, a ring
      around it, and a looser outer ring.
    */
    static ringPlan(n) {
      if (n <= 1) return [1, 0, 0];
      if (n <= 3) return [1, n - 1, 0];
      if (n <= 5) return [1, 3, n - 4];

      /*
        Six to ten is the range a bouquet is actually sold in, and visual
        testing earned each of these its own line. The generated plan gave eight
        stems only two outer slots, and two points on an outer ring either side
        of a dense middle read as a diagonal streak rather than a bouquet.
      */
      const TEMPLATES = {
        6: [1, 3, 2],
        7: [1, 3, 3],
        8: [1, 4, 3],
        9: [2, 4, 3],
        10: [2, 4, 4],
      };
      if (TEMPLATES[n]) return TEMPLATES[n];

      /* Beyond ten the outer ring simply keeps growing. */
      return [2, 4, n - 6];
    }

    /*
      The slots for n stems, as normalised coordinates. Rings are elliptical —
      a bouquet is wider than it is tall — and each ring's phase comes from the
      seed, so shuffling turns the rings rather than scattering the flowers.
    */
    /*
      The slots for n stems, as normalised coordinates.

      Positions come from a phyllotactic disc — the golden-angle spiral a
      sunflower head grows on. It is used here for the property that makes it
      worth the name-drop: it fills a disc *evenly* at any count, with no
      clumps, no gaps and no straight lines. Concentric rings with a random
      phase were tried first and did not: at some seeds they collapsed into a
      diagonal streak, and at others they left one side bare.

      The spiral also happens to order its points from the centre outwards,
      which is exactly the order the role bands want — so the focal blooms take
      the middle and the greenery ends up at the rim without any sorting.
    */
    slotsFor(n, random, seed) {
      const [focalSlots, secondarySlots] = BouquetLayoutEngine.ringPlan(n);
      /* One draw, and always the first one, so the rings turn only on a shuffle. */
      const phase = random() * Math.PI * 2;

      /*
        The disc grows with the bouquet. Spreading two stems across the full
        width leaves them looking dropped rather than gathered — a half-built
        bouquet should read as a small posy that fills out, not as a full
        bouquet with most of it missing.
      */
      const fill = Math.min(1, 0.46 + n * 0.06);
      const rx = 0.3 * fill * this.spread;
      const ry = 0.255 * fill * this.spread;
      const slots = [];

      for (let i = 0; i < n; i += 1) {
        const radius = Math.sqrt((i + 0.5) / n);
        const angle = phase + i * GOLDEN_ANGLE;
        /*
          Just enough wobble that it never reads as a computed pattern — drawn
          against the slot's own number, so slot four wobbles the same way in a
          bouquet of five as in a bouquet of ten.
        */
        const wobble = 1 + (streamFor(seed, 'slot' + i)() - 0.5) * 0.14;

        let x = this.centre.x + Math.cos(angle) * radius * rx * wobble;
        const y = this.centre.y + Math.sin(angle) * radius * ry * wobble;

        /*
          The taper is what makes it a bouquet rather than a wreath. Stems
          gathered in one hand splay at the top and converge at the tie, so the
          lower a slot sits the closer it is drawn to the middle — giving the
          dome silhouette and leaving the stems somewhere to meet.
        */
        const depth = clamp((y - this.centre.y) / ry, -1, 1);
        if (depth > 0) x = this.centre.x + (x - this.centre.x) * (1 - depth * 0.4);

        let role;
        let ring;
        if (i < focalSlots) {
          role = 'focal';
          ring = 0;
        } else if (i < focalSlots + secondarySlots) {
          role = 'secondary';
          ring = 1;
        } else {
          role = i % 2 ? 'greenery' : 'filler';
          ring = 2;
        }

        slots.push({ x: clamp(x, 0.12, 0.88), y: clamp(y, 0.08, 0.68), role, ring, angle });
      }

      /* Already centre-outwards, which is the order assignment wants. */
      return slots;
    }

    /*
      Deal the instances out so repeats never end up side by side: take one of
      each distinct product in turn, then go round again. Rose, daisy, rose,
      fern, rose — rather than rose, rose, rose.
    */
    static distribute(items) {
      const buckets = new Map();
      items.forEach((item) => {
        if (!buckets.has(item.catalogId)) buckets.set(item.catalogId, []);
        buckets.get(item.catalogId).push(item);
      });

      const queues = Array.from(buckets.values());
      const dealt = [];
      let placed = 0;

      while (placed < items.length) {
        queues.forEach((queue) => {
          const next = queue.shift();
          if (next) {
            dealt.push(next);
            placed += 1;
          }
        });
      }

      return dealt;
    }

    /*
      Give every slot the best available stem: its own role first, then the
      roles that role is happy to stand in for. A bouquet with no greenery in it
      still fills its outer ring rather than leaving holes.
    */
    static assign(units, slots, catalog) {
      const pool = units.map((unit) => ({
        unit,
        role: roleOf(catalog.get(unit.catalogId) || {}),
      }));

      const taken = new Set();
      const pairs = [];

      slots.forEach((slot) => {
        const preference = ROLE_FALLBACK[slot.role] || [slot.role];
        let chosen = -1;

        for (const wanted of preference) {
          chosen = pool.findIndex((entry, index) => !taken.has(index) && entry.role === wanted);
          if (chosen >= 0) break;
        }
        if (chosen < 0) chosen = pool.findIndex((entry, index) => !taken.has(index));
        if (chosen < 0) return;

        taken.add(chosen);
        pairs.push({ slot, unit: pool[chosen].unit, role: pool[chosen].role });
      });

      return pairs;
    }

    /*
      Whatever the customer has changed by hand wins over what the engine chose.
      Only the fields they actually touched are overridden, so a flower they
      turned but never moved keeps the position the engine gave it.
    */
    static withOverride(transform, instance) {
      return instance.override ? Object.assign(transform, instance.override) : transform;
    }

    /*
      The one public method. items + seed in, render transforms out.
      Never mutates anything, never reads the clock, never calls Math.random.
    */
    arrange(items, catalog, seed) {
      const random = mulberry32(seed || 1);

      const stems = [];
      const accessories = [];
      items.forEach((instance) => {
        const item = catalog.get(instance.catalogId);
        if (!item) return;
        (isAccessory(item) ? accessories : stems).push(instance);
      });

      const transforms = [];

      /* --- The bouquet itself ------------------------------------------- */
      if (stems.length) {
        const slots = this.slotsFor(stems.length, random, seed || 1);
        const pairs = BouquetLayoutEngine.assign(BouquetLayoutEngine.distribute(stems), slots, catalog);

        pairs.forEach(({ slot, unit, role }) => {
          const item = catalog.get(unit.catalogId);
          /* This stem's own stream, so nothing else being added can disturb it. */
          const own = streamFor(seed || 1, unit.instanceId);
          const range = ROLE_SCALE[role] || ROLE_SCALE.secondary;
          const declared =
            Number.isFinite(item.visual && item.visual.scale) && item.visual.scale > 0 ? item.visual.scale : 1;

          /*
            Rotation follows how far the stem sits from the middle, so the
            bouquet fans outward the way a hand-tied bunch opens — plus a couple
            of degrees of variation so no two repeats look stamped.
          */
          const fan = (slot.x - this.centre.x) * 46;
          const jitter = (own() - 0.5) * 9;

          transforms.push(
            BouquetLayoutEngine.withOverride(
              {
                instanceId: unit.instanceId,
                catalogId: unit.catalogId,
                /* What the engine chose, before any hand edit — restacking counts from here. */
                baseLayer: Number.isFinite(item.visual && item.visual.layer)
                  ? item.visual.layer
                  : ROLE_LAYER[role] + slot.ring,
                x: slot.x,
                y: slot.y,
                scale: declared * lerp(range[0], range[1], own()),
                rotation: clamp(fan + jitter, -16, 16),
                layer: Number.isFinite(item.visual && item.visual.layer)
                  ? item.visual.layer
                  : ROLE_LAYER[role] + slot.ring,
              },
              unit,
            ),
          );
        });
      }

      /* --- The dressing ------------------------------------------------- */
      accessories.forEach((instance, index) => {
        const item = catalog.get(instance.catalogId);
        const declared =
          Number.isFinite(item.visual && item.visual.scale) && item.visual.scale > 0 ? item.visual.scale : 1;
        /*
          Its own stream too. The dressing is placed after the stems, so on the
          shared stream every flower added shifted the wrap a little further
          along — the one piece on the canvas that should never move on its own.
        */
        const placement = this.accessoryPlacement(item, index, streamFor(seed || 1, instance.instanceId));

        const accessoryLayer = Number.isFinite(item.visual && item.visual.layer)
          ? item.visual.layer
          : ACCESSORY_LAYER[item.category] !== undefined
            ? ACCESSORY_LAYER[item.category]
            : ROLE_LAYER.accent;

        /*
          One anchor for the whole piece, with any hand edit already folded in.
          Every part is derived from this, so dragging, turning or resizing a
          two-part wrap moves both halves as one object instead of pulling them
          apart.
        */
        const anchor = BouquetLayoutEngine.withOverride(
          {
            instanceId: instance.instanceId,
            catalogId: instance.catalogId,
            baseLayer: accessoryLayer,
            x: placement.x,
            y: placement.y,
            scale: declared * placement.scale,
            rotation: placement.rotation,
            layer: accessoryLayer,
          },
          instance,
        );

        /*
          A wrap is drawn twice: the backing sheet behind everything, and the
          front flap over the stem ends. The flowers live in the layers between,
          so they sit inside the cone by default — and the forward and back
          buttons let one be pushed out past the front flap, or tucked back in.

          It stays one instance throughout: one thing to add, one cart line, one
          thing to remove.
        */
        const parts =
          item.visual && item.visual.front
            ? [
                { part: 'back', layer: WRAP_BACK_LAYER, drop: 0 },
                { part: 'front', layer: WRAP_FRONT_LAYER, drop: WRAP_FRONT_DROP },
              ]
            : [{ part: 'whole', layer: anchor.layer, drop: 0 }];

        parts.forEach((piece) => {
          transforms.push(
            Object.assign({}, anchor, {
              part: piece.part,
              /*
                Offset from the anchor rather than set outright, so a wrap the
                customer has dragged keeps its fold: both halves move together
                and the flap stays the same distance below the sheet.
              */
              y: anchor.y + piece.drop,
              /* A hand-set layer moves the pair; the parts keep their spacing. */
              layer:
                instance.override && Number.isFinite(instance.override.layer)
                  ? instance.override.layer + (piece.layer - anchor.baseLayer)
                  : piece.layer,
              baseLayer: piece.layer,
            }),
          );
        });
      });

      /* Back to front, insertion order breaking ties. */
      return transforms.sort((a, b) => a.layer - b.layer);
    }

    /*
      Accessories are structural rather than gathered, so they sit where the
      structure wants them: the wrap around the stems, the ribbon at the tie,
      charms pinned onto the bouquet itself.
    */
    accessoryPlacement(item, index, random) {
      switch (item.category) {
        case 'wrapper':
          return { x: 0.5 + (random() - 0.5) * 0.02, y: 0.62, scale: 1.85, rotation: (random() - 0.5) * 3 };
        case 'ribbon':
          return { x: 0.5 + (random() - 0.5) * 0.04, y: 0.7, scale: 1.2, rotation: (random() - 0.5) * 8 };
        case 'charm':
          return {
            x: clamp(0.5 + (random() - 0.5) * 0.34, 0.2, 0.8),
            y: clamp(0.4 + (random() - 0.5) * 0.24, 0.2, 0.6),
            scale: 1,
            rotation: (random() - 0.5) * 18,
          };
        default:
          return {
            x: clamp(0.5 + (random() - 0.5) * 0.4, 0.16, 0.84),
            y: clamp(0.6 + index * 0.05, 0.3, 0.8),
            scale: 1,
            rotation: (random() - 0.5) * 10,
          };
      }
    }
  }

  /* ============================================================ Image cache */

  /*
    Each asset is fetched once and shared by every instance that uses it.

    createImageBitmap from a fetched blob is preferred: it decodes off the main
    thread and, because the pixels came through fetch, the canvas we sample the
    alpha mask from is never tainted. When that path is unavailable the plain
    Image fallback still draws — it simply loses the mask and falls back to
    bounding-box hit testing.

    A failed asset is remembered as failed and skipped. It never stops the rest
    of the bouquet from drawing.
  */
  const MASK_SIZE = 48;
  const DEFAULT_ART_SIZE = 512;

  class BouquetImageCache {
    constructor(onChange) {
      this.entries = new Map();
      this.onChange = onChange;
      this.disposed = false;
    }

    get(url) {
      if (!url) return null;
      const existing = this.entries.get(url);
      if (existing) return existing;

      const entry = { status: 'loading', source: null, width: 0, height: 0, mask: null };
      this.entries.set(url, entry);
      this.load(url, entry);
      return entry;
    }

    load(url, entry) {
      const settle = (source, width, height) => {
        if (this.disposed) {
          if (source && typeof source.close === 'function') source.close();
          return;
        }
        entry.status = 'loaded';
        entry.source = source;
        entry.width = width;
        entry.height = height;
        entry.mask = this.buildMask(source, width, height);
        if (this.onChange) this.onChange();
      };

      const fail = () => {
        if (this.disposed) return;
        entry.status = 'failed';
        if (this.onChange) this.onChange();
      };

      const viaImage = (crossOrigin) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          if (crossOrigin) image.crossOrigin = 'anonymous';
          image.decoding = 'async';
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = url;
        });

      /*
        SVG goes down the <img> path deliberately. createImageBitmap would
        rasterise it once at its intrinsic size and we would then be scaling a
        bitmap; an <img> is re-rasterised by the browser at whatever size
        drawImage asks for, which is the whole reason to draw the stems as
        vectors in the first place.
      */
      const isVector = /\.svg(\?|#|$)/i.test(url);

      const bitmapPath =
        !isVector && typeof createImageBitmap === 'function' && typeof fetch === 'function'
          ? fetch(url, { mode: 'cors', credentials: 'omit' })
              .then((response) => {
                if (!response.ok) throw new Error(`bouquet asset ${response.status}`);
                return response.blob();
              })
              .then((blob) => createImageBitmap(blob))
          : Promise.reject(new Error('createImageBitmap unavailable'));

      /*
        An SVG with only a viewBox and no width/height reports 0x0 in some
        browsers. Falling back to a square keeps the aspect ratio sane rather
        than collapsing the stem to nothing.
      */
      const settleImage = (image) =>
        settle(image, image.naturalWidth || DEFAULT_ART_SIZE, image.naturalHeight || DEFAULT_ART_SIZE);

      bitmapPath
        .then((bitmap) => settle(bitmap, bitmap.width, bitmap.height))
        .catch(() =>
          viaImage(true)
            .then(settleImage)
            .catch(() => viaImage(false).then(settleImage).catch(fail)),
        );
    }

    /*
      A tiny alpha map, so clicking between two overlapping petals picks the one
      actually under the pointer rather than whichever rectangle is on top. If
      the pixels cannot be read — a tainted canvas, no 2D context — we return
      null and the renderer falls back to the bounding box.
    */
    buildMask(source, width, height) {
      if (!width || !height) return null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = MASK_SIZE;
        canvas.height = MASK_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(source, 0, 0, MASK_SIZE, MASK_SIZE);
        const { data } = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE);
        const mask = new Uint8Array(MASK_SIZE * MASK_SIZE);
        for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4 + 3];
        return mask;
      } catch (error) {
        return null;
      }
    }

    destroy() {
      this.disposed = true;
      this.entries.forEach((entry) => {
        if (entry.source && typeof entry.source.close === 'function') entry.source.close();
      });
      this.entries.clear();
      this.onChange = null;
    }
  }

  /* =============================================================== Renderer */

  const ITEM_BASE_FRACTION = 0.3;
  const ADD_MS = 340;
  /*
    A fingertip is not a mouse pointer.

    Thirteen pixels of circle is a comfortable target under a cursor the user
    can see and place exactly; under a finger, which covers roughly a centimetre
    and hides what it is aiming at, it is a guess. On a touch screen the handles
    are drawn larger and given a wider catchment, and the turn handle is held
    further off the bloom so the hand holding the phone is not covering the
    thing it is turning.

    Read once, at load: a device does not usually change what it is halfway
    through a visit, and re-reading it per frame would cost more than it saves.
  */
  const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const HANDLE_RADIUS = COARSE_POINTER ? 17 : 13;
  const HANDLE_HIT_RADIUS = COARSE_POINTER ? 30 : 22; /* at least a 44px touch target */
  const ROTATE_HANDLE_OFFSET = COARSE_POINTER ? 38 : 28;
  const SHUFFLE_MS = 460;

  /*
    The stand-in used when a product has no drawing yet.

    A shop creates its products before it draws them, and a builder that renders
    nothing in that window looks broken rather than unfinished. The shape comes
    from the category the merchant assigned — the same data everything else here
    runs on — and is replaced the moment real art exists.
  */
  const PLACEHOLDER_ART = { status: 'placeholder', source: null, width: 200, height: 260, mask: null };

  const PLACEHOLDER_PALETTE = {
    flower: { primary: '#d98ca6', accent: '#f2d06b', stem: '#7f9a6a' },
    filler: { primary: '#e8cf8f', accent: '#f5ead0', stem: '#7f9a6a' },
    leaf: { primary: '#7f9a6a', accent: '#5f7a4d', stem: '#5f7a4d' },
    wrapper: { primary: '#d8c3a5', accent: '#c2a785', stem: '#c2a785' },
    ribbon: { primary: '#a8bcd0', accent: '#8ea4bb', stem: '#8ea4bb' },
    charm: { primary: '#c9a7d4', accent: '#f2d06b', stem: '#c9a7d4' },
  };
  const PLACEHOLDER_FALLBACK = { primary: '#c4b5a5', accent: '#e0d6c8', stem: '#8f9a85' };

  /*
    The Canvas. It draws the arrangement it is handed and hit tests it. It holds
    no bouquet state, decides no positions, and contains no composition rules —
    all of that is BouquetLayoutEngine's job, and this class would render a
    bouquet of anything without noticing.

    The only interaction is: hover to see which stem is under the pointer, click
    to take it out. No drag, no rotate, no scale, no selection handles. The
    customer is a shopper, not a graphic designer.
  */
  class BouquetRenderer {
    constructor(options) {
      this.canvas = options.canvas;
      this.stage = options.stage;
      this.images = options.images;
      this.catalog = options.catalog;
      this.backgroundUrl = options.background || '';
      this.abilities = options.abilities || { drag: true, rotate: true, scale: true };
      this.callbacks = options.callbacks;
      this.gesture = null;

      this.ctx = null;
      this.arrangement = [];
      this.previous = new Map();
      this.motion = null;
      this.entering = new Map();
      this.hoveredId = null;

      this.width = 0;
      this.height = 0;
      this.frame = 0;
      this.loopFrame = 0;
      this.looping = false;
      this.resizeObserver = null;
    }

    mount() {
      try {
        this.ctx = this.canvas.getContext('2d');
      } catch (error) {
        this.ctx = null;
      }
      if (!this.ctx) return false;

      this.onPointerDown = this.handlePointerDown.bind(this);
      this.onPointerMove = this.handlePointerMove.bind(this);
      this.onPointerEnd = this.handlePointerEnd.bind(this);
      this.onPointerLeave = this.handlePointerLeave.bind(this);
      this.onResize = this.measure.bind(this);

      this.canvas.addEventListener('pointerdown', this.onPointerDown);
      this.canvas.addEventListener('pointermove', this.onPointerMove);
      this.canvas.addEventListener('pointerup', this.onPointerEnd);
      this.canvas.addEventListener('pointercancel', this.onPointerEnd);
      this.canvas.addEventListener('pointerleave', this.onPointerLeave);

      /*
        A ResizeObserver on the container, not a window resize listener — the
        Canvas can change size when nothing about the window did. It only ever
        re-measures and repaints; it can never re-arrange.
      */
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(this.onResize);
        this.resizeObserver.observe(this.stage);
      } else {
        window.addEventListener('resize', this.onResize);
      }

      this.measure();
      return true;
    }

    destroy() {
      this.stopLoop();

      this.canvas.removeEventListener('pointerdown', this.onPointerDown);
      this.canvas.removeEventListener('pointermove', this.onPointerMove);
      this.canvas.removeEventListener('pointerup', this.onPointerEnd);
      this.canvas.removeEventListener('pointercancel', this.onPointerEnd);
      this.canvas.removeEventListener('pointerleave', this.onPointerLeave);

      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      } else {
        window.removeEventListener('resize', this.onResize);
      }

      this.previous.clear();
      this.entering.clear();
      this.motion = null;
      this.hoveredId = null;
      this.selectedId = null;
      this.gesture = null;
      this.ctx = null;
    }

    /* --------------------------------------------------------------- Sizing */

    measure() {
      const rect = this.stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      /*
        The bitmap is sized in device pixels and the context scaled once, so
        everything below works in logical pixels. Skipping this is what makes a
        Canvas look soft on a high-density screen.
      */
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      this.width = rect.width;
      this.height = rect.height;
      this.canvas.width = Math.round(rect.width * ratio);
      this.canvas.height = Math.round(rect.height * ratio);
      this.canvas.style.width = `${rect.width}px`;
      this.canvas.style.height = `${rect.height}px`;
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      this.scheduleRender();
    }

    /* ---------------------------------------------------------- Arrangement */

    /*
      Hand the renderer a new arrangement. `reason` says whether the change
      deserves a transition: stems that were already there glide to their new
      places on a shuffle, and brand new stems settle in on an add.
    */
    setArrangement(arrangement, reason, selectedId) {
      this.selectedId = selectedId === undefined ? this.selectedId : selectedId;
      const before = new Map(this.arrangement.map((t) => [t.instanceId, t]));
      const now = performance.now();
      const still = prefersReducedMotion();

      this.arrangement = arrangement;

      if (!still) {
        arrangement.forEach((transform) => {
          if (!before.has(transform.instanceId)) this.entering.set(transform.instanceId, now);
        });

        if (reason === 'shuffle' && before.size) {
          this.previous = before;
          this.motion = { start: now, duration: SHUFFLE_MS };
        }
      }

      /* Anything no longer in the bouquet stops being animated. */
      const live = new Set(arrangement.map((t) => t.instanceId));
      this.entering.forEach((_, id) => {
        if (!live.has(id)) this.entering.delete(id);
      });
      if (this.hoveredId && !live.has(this.hoveredId)) this.hoveredId = null;
      if (this.selectedId && !live.has(this.selectedId)) this.selectedId = null;

      this.scheduleRender();
      if (this.entering.size || this.motion) this.startLoop();
    }

    /* --------------------------------------------------------------- Frames */

    /*
      Render on demand. A permanent requestAnimationFrame loop repainting an
      unchanged scene is a battery bug; the loop below runs only while something
      is actually moving and stops itself the moment nothing is.
    */
    scheduleRender() {
      if (this.frame || this.looping) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }

    startLoop() {
      if (this.looping) return;
      this.looping = true;
      const step = () => {
        if (!this.looping) return;
        this.render();
        if (!this.entering.size && !this.motion) {
          this.looping = false;
          this.loopFrame = 0;
          return;
        }
        this.loopFrame = requestAnimationFrame(step);
      };
      this.loopFrame = requestAnimationFrame(step);
    }

    stopLoop() {
      this.looping = false;
      if (this.loopFrame) cancelAnimationFrame(this.loopFrame);
      if (this.frame) cancelAnimationFrame(this.frame);
      this.loopFrame = 0;
      this.frame = 0;
    }

    /* ---------------------------------------------------------------- Art */

    /*
      What to draw an item with: the merchant's drawing, or — including when the
      file 404s — a placeholder shape. Only a still-loading asset defers, so a
      slow network shows nothing for a moment rather than a shape that pops away.
    */
    artFor(item, part) {
      const visual = (item && item.visual) || {};
      /* A wrap has two pictures; everything else has one. */
      const url = part === 'front' ? visual.front : visual.asset;
      if (!url) return PLACEHOLDER_ART;

      const entry = this.images.get(url);
      if (!entry) return PLACEHOLDER_ART;
      if (entry.status === 'loaded') return entry;
      if (entry.status === 'failed') return PLACEHOLDER_ART;
      return null;
    }

    /* ------------------------------------------------------------- Geometry */

    /* Normalised 0–1 from the engine, pixels only at draw time. */
    resolve(transform, now) {
      const settle = this.settleFactor(transform.instanceId, now);
      let { x, y, scale, rotation } = transform;

      /* Mid-shuffle, glide from where the stem was to where it now belongs. */
      if (this.motion) {
        const t = this.easing((now - this.motion.start) / this.motion.duration);
        const from = this.previous.get(transform.instanceId);
        if (from) {
          x = lerp(from.x, x, t);
          y = lerp(from.y, y, t);
          scale = lerp(from.scale, scale, t);
          rotation = lerp(from.rotation, rotation, t);
        }
      }

      return { x, y, scale: scale * settle.scale, rotation, alpha: settle.alpha };
    }

    easing(t) {
      const clamped = clamp(t, 0, 1);
      return 1 - Math.pow(1 - clamped, 3);
    }

    settleFactor(instanceId, now) {
      const started = this.entering.get(instanceId);
      if (!started) return { scale: 1, alpha: 1 };
      const t = (now - started) / ADD_MS;
      if (t >= 1) return { scale: 1, alpha: 1 };
      const eased = this.easing(t);
      return { scale: 0.74 + eased * 0.26, alpha: eased };
    }

    /* The on-canvas size of an item, in logical pixels, aspect preserved. */
    boxOf(entry, scale) {
      const base = Math.min(this.width, this.height) * ITEM_BASE_FRACTION;
      const longest = Math.max(entry.width, entry.height) || 1;
      const unit = (base / longest) * scale;
      return { width: entry.width * unit, height: entry.height * unit };
    }

    /* ----------------------------------------------------------------- Draw */

    render() {
      if (!this.ctx || !this.width || !this.height) return;
      const ctx = this.ctx;
      const now = performance.now();

      /*
        Retire finished animations by the clock, not as each is drawn. An item
        whose art never loads is never drawn, and if its entry lingered the loop
        would never find a reason to stop — a permanent rAF loop by accident.
      */
      this.entering.forEach((started, id) => {
        if (now - started >= ADD_MS) this.entering.delete(id);
      });
      if (this.motion && now - this.motion.start >= this.motion.duration) {
        this.motion = null;
        this.previous.clear();
      }

      ctx.clearRect(0, 0, this.width, this.height);
      this.drawBackground(ctx);

      this.arrangement.forEach((transform) => {
        const item = this.catalog.get(transform.catalogId);
        if (!item) return;

        const entry = this.artFor(item, transform.part);
        if (!entry) return;

        const placed = this.resolve(transform, now);
        const box = this.boxOf(entry, placed.scale);

        ctx.save();
        ctx.globalAlpha = placed.alpha;
        ctx.translate(placed.x * this.width, placed.y * this.height);
        ctx.rotate((placed.rotation * Math.PI) / 180);

        /*
          Drawn whole, at its own aspect ratio — never cropped, masked or
          shadowed. What the merchant drew is what appears.
        */
        if (entry.status === 'placeholder') {
          this.drawPlaceholder(ctx, box, item);
        } else {
          ctx.drawImage(entry.source, -box.width / 2, -box.height / 2, box.width, box.height);
        }

        ctx.restore();
      });

      this.drawSelection(ctx, now);
    }

    drawBackground(ctx) {
      if (this.backgroundUrl) {
        const entry = this.images.get(this.backgroundUrl);
        if (entry && entry.status === 'loaded') {
          const scale = Math.max(this.width / entry.width, this.height / entry.height);
          const width = entry.width * scale;
          const height = entry.height * scale;
          ctx.drawImage(entry.source, (this.width - width) / 2, (this.height - height) / 2, width, height);
          return;
        }
      }

      /*
        An empty Canvas is a warm pool of light rather than a blank rectangle,
        so an untouched builder reads as an invitation.
      */
      const gradient = ctx.createRadialGradient(
        this.width / 2,
        this.height * 0.42,
        Math.min(this.width, this.height) * 0.05,
        this.width / 2,
        this.height * 0.42,
        Math.max(this.width, this.height) * 0.72,
      );
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    /*
      The stand-in shapes, drawn in the item's own local space — the caller has
      already translated and rotated. Shape chosen by the merchant's category,
      never by anything read off a title.
    */
    drawPlaceholder(ctx, box, item) {
      const palette = PLACEHOLDER_PALETTE[item.category] || PLACEHOLDER_FALLBACK;
      const width = box.width;
      const height = box.height;
      const radius = Math.min(width, height) / 2;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const stem = () => {
        ctx.strokeStyle = palette.stem;
        ctx.lineWidth = Math.max(1.5, radius * 0.08);
        ctx.beginPath();
        ctx.moveTo(0, radius * 0.2);
        ctx.lineTo(0, height / 2);
        ctx.stroke();
      };

      const petals = (count, length, girth) => {
        ctx.fillStyle = palette.primary;
        for (let i = 0; i < count; i += 1) {
          ctx.save();
          ctx.rotate((i / count) * Math.PI * 2);
          ctx.beginPath();
          ctx.ellipse(0, -length, girth, length, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      };

      switch (item.category) {
        case 'leaf': {
          stem();
          ctx.fillStyle = palette.primary;
          [-1, 1].forEach((side, index) => {
            ctx.save();
            ctx.rotate(side * 0.5);
            ctx.beginPath();
            ctx.ellipse(0, -radius * (0.45 + index * 0.1), radius * 0.24, radius * 0.55, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          });
          break;
        }

        case 'filler': {
          stem();
          ctx.fillStyle = palette.primary;
          for (let i = 0; i < 7; i += 1) {
            const angle = (i / 7) * Math.PI * 2;
            const spread = radius * (i % 2 ? 0.34 : 0.58);
            ctx.beginPath();
            ctx.arc(Math.cos(angle) * spread, Math.sin(angle) * spread - radius * 0.1, radius * 0.16, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }

        case 'wrapper': {
          ctx.fillStyle = palette.primary;
          ctx.beginPath();
          ctx.moveTo(-width * 0.42, -height * 0.34);
          ctx.lineTo(width * 0.42, -height * 0.34);
          ctx.lineTo(width * 0.14, height * 0.46);
          ctx.lineTo(-width * 0.14, height * 0.46);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = palette.accent;
          ctx.lineWidth = Math.max(1.5, radius * 0.06);
          ctx.stroke();
          break;
        }

        case 'ribbon': {
          ctx.fillStyle = palette.primary;
          [-1, 1].forEach((side) => {
            ctx.beginPath();
            ctx.ellipse(side * radius * 0.34, 0, radius * 0.32, radius * 0.22, side * 0.4, 0, Math.PI * 2);
            ctx.fill();
          });
          ctx.fillStyle = palette.accent;
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.14, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = palette.primary;
          ctx.lineWidth = Math.max(1.5, radius * 0.09);
          ctx.beginPath();
          ctx.moveTo(-radius * 0.14, radius * 0.08);
          ctx.lineTo(-radius * 0.3, radius * 0.62);
          ctx.moveTo(radius * 0.14, radius * 0.08);
          ctx.lineTo(radius * 0.3, radius * 0.62);
          ctx.stroke();
          break;
        }

        case 'charm': {
          ctx.fillStyle = palette.primary;
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.42, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = palette.accent;
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.18, 0, Math.PI * 2);
          ctx.fill();
          break;
        }

        default: {
          /* A flower, and the shape anything uncategorised falls back to. */
          stem();
          petals(8, radius * 0.42, radius * 0.2);
          ctx.fillStyle = palette.accent;
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    }

    /*
      The selected piece, and the handles for working on it.

      Corners are the artwork's own box turned by its rotation, so the outline
      hugs a tilted flower rather than boxing it off square. The handles hang off
      that same turned frame, which keeps them where the eye expects them however
      far the piece has been spun.
    */
    handlesFor(transform, now) {
      const item = this.catalog.get(transform.catalogId);
      if (!item) return null;
      const entry = this.artFor(item, transform.part);
      if (!entry) return null;

      const placed = this.resolve(transform, now);
      const box = this.boxOf(entry, placed.scale);
      const centre = { x: placed.x * this.width, y: placed.y * this.height };
      const half = { x: box.width / 2, y: box.height / 2 };
      const radians = (placed.rotation * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);

      const corner = (dx, dy) => ({ x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos });

      return {
        centre,
        box,
        corners: [corner(-half.x, -half.y), corner(half.x, -half.y), corner(half.x, half.y), corner(-half.x, half.y)],
        rotate: corner(0, -half.y - ROTATE_HANDLE_OFFSET),
        scale: corner(half.x, half.y),
        remove: corner(half.x, -half.y),
      };
    }

    drawSelection(ctx, now) {
      if (!this.selectedId) return;
      const transform = this.arrangement.find((t) => t.instanceId === this.selectedId);
      if (!transform) return;
      const geometry = this.handlesFor(transform, now);
      if (!geometry) return;

      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(20, 20, 20, 0.55)';
      ctx.beginPath();
      geometry.corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      if (this.abilities.rotate) {
        const top = {
          x: (geometry.corners[0].x + geometry.corners[1].x) / 2,
          y: (geometry.corners[0].y + geometry.corners[1].y) / 2,
        };
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(geometry.rotate.x, geometry.rotate.y);
        ctx.stroke();
        this.drawHandle(ctx, geometry.rotate, 'rotate');
      }
      if (this.abilities.scale) this.drawHandle(ctx, geometry.scale, 'scale');
      this.drawHandle(ctx, geometry.remove, 'remove');

      ctx.restore();
    }

    drawHandle(ctx, point, kind) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = kind === 'remove' ? 'rgba(24, 24, 24, 0.92)' : 'rgba(255, 255, 255, 0.96)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(20, 20, 20, 0.35)';
      ctx.stroke();

      ctx.strokeStyle = kind === 'remove' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(20, 20, 20, 0.8)';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (kind === 'remove') {
        ctx.moveTo(point.x - 4, point.y - 4);
        ctx.lineTo(point.x + 4, point.y + 4);
        ctx.moveTo(point.x + 4, point.y - 4);
        ctx.lineTo(point.x - 4, point.y + 4);
      } else if (kind === 'rotate') {
        ctx.arc(point.x, point.y, 5, Math.PI * 0.25, Math.PI * 1.85);
      } else {
        ctx.moveTo(point.x - 4, point.y + 4);
        ctx.lineTo(point.x + 4, point.y - 4);
        ctx.moveTo(point.x + 1, point.y - 4);
        ctx.lineTo(point.x + 4, point.y - 4);
        ctx.lineTo(point.x + 4, point.y - 1);
      }
      ctx.stroke();
      ctx.restore();
    }

    /* ---------------------------------------------------------- Hit testing */

    /*
      The pointer is converted back through getBoundingClientRect, so the maths
      stays right after a resize, a zoom or a page scroll.
    */
    pointerPoint(event) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * this.width,
        y: ((event.clientY - rect.top) / rect.height) * this.height,
      };
    }

    static distance(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    /* Topmost wins, so the search walks the draw order backwards. */
    hitTest(point, now) {
      for (let i = this.arrangement.length - 1; i >= 0; i -= 1) {
        const transform = this.arrangement[i];
        const item = this.catalog.get(transform.catalogId);
        if (!item) continue;
        const entry = this.artFor(item, transform.part);
        if (!entry) continue;

        const placed = this.resolve(transform, now);
        const box = this.boxOf(entry, placed.scale);
        const centre = { x: placed.x * this.width, y: placed.y * this.height };
        const radians = (-placed.rotation * Math.PI) / 180;
        const dx = point.x - centre.x;
        const dy = point.y - centre.y;
        const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
        const localY = dx * Math.sin(radians) + dy * Math.cos(radians);

        if (Math.abs(localX) > box.width / 2 || Math.abs(localY) > box.height / 2) continue;

        if (entry.mask) {
          const u = clamp(Math.floor((localX / box.width + 0.5) * MASK_SIZE), 0, MASK_SIZE - 1);
          const v = clamp(Math.floor((localY / box.height + 0.5) * MASK_SIZE), 0, MASK_SIZE - 1);
          if (entry.mask[v * MASK_SIZE + u] < 24) continue;
        }

        return transform;
      }
      return null;
    }

    /* --------------------------------------------------------------- Pointer */

    handlePointerDown(event) {
      if (!this.ctx || event.button > 0) return;
      const now = performance.now();
      const point = this.pointerPoint(event);

      /* A handle on the selected piece beats whatever is underneath it. */
      const selected = this.arrangement.find((t) => t.instanceId === this.selectedId);
      if (selected) {
        const geometry = this.handlesFor(selected, now);
        if (geometry) {
          if (BouquetRenderer.distance(point, geometry.remove) <= HANDLE_HIT_RADIUS) {
            this.hoveredId = null;
            this.callbacks.onRemove(selected.instanceId);
            return;
          }
          if (this.abilities.rotate && BouquetRenderer.distance(point, geometry.rotate) <= HANDLE_HIT_RADIUS) {
            this.beginGesture(event, 'rotate', selected, point, geometry);
            return;
          }
          if (this.abilities.scale && BouquetRenderer.distance(point, geometry.scale) <= HANDLE_HIT_RADIUS) {
            this.beginGesture(event, 'scale', selected, point, geometry);
            return;
          }
        }
      }

      const hit = this.hitTest(point, now);
      if (!hit) {
        this.callbacks.onSelect(null);
        return;
      }

      this.callbacks.onSelect(hit.instanceId);
      if (this.abilities.drag) {
        this.beginGesture(event, 'move', hit, point, this.handlesFor(hit, now));
      }
    }

    beginGesture(event, mode, transform, point, geometry) {
      const centre = geometry ? geometry.centre : { x: transform.x * this.width, y: transform.y * this.height };

      this.gesture = {
        mode,
        instanceId: transform.instanceId,
        pointerId: event.pointerId,
        start: { x: transform.x, y: transform.y, scale: transform.scale, rotation: transform.rotation },
        grab: { x: point.x - centre.x, y: point.y - centre.y },
        startAngle: Math.atan2(point.y - centre.y, point.x - centre.x),
        startDistance: Math.max(1, BouquetRenderer.distance(point, centre)),
        moved: false,
      };

      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        /* Capture is a convenience; pointerup on the canvas still ends the gesture. */
      }

      this.canvas.style.cursor = mode === 'move' ? 'grabbing' : 'crosshair';
      this.callbacks.onGestureStart(transform.instanceId);
    }

    handlePointerMove(event) {
      if (!this.ctx) return;

      const gesture = this.gesture;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        /* Not dragging: just say what is under the pointer. */
        const hit = this.hitTest(this.pointerPoint(event), performance.now());
        const id = hit ? hit.instanceId : null;
        if (id === this.hoveredId) return;
        this.hoveredId = id;
        this.canvas.style.cursor = id ? 'grab' : 'default';
        this.scheduleRender();
        return;
      }

      const transform = this.arrangement.find((t) => t.instanceId === gesture.instanceId);
      if (!transform) return;

      const point = this.pointerPoint(event);
      gesture.moved = true;

      if (gesture.mode === 'move') {
        this.callbacks.onPlace(gesture.instanceId, {
          x: clamp((point.x - gesture.grab.x) / this.width, 0.04, 0.96),
          y: clamp((point.y - gesture.grab.y) / this.height, 0.04, 0.96),
        });
        return;
      }

      const centre = { x: transform.x * this.width, y: transform.y * this.height };

      if (gesture.mode === 'rotate') {
        const angle = Math.atan2(point.y - centre.y, point.x - centre.x);
        const delta = ((angle - gesture.startAngle) * 180) / Math.PI;
        this.callbacks.onPlace(gesture.instanceId, {
          rotation: clamp(gesture.start.rotation + delta, -180, 180),
        });
        return;
      }

      if (gesture.mode === 'scale') {
        const ratio = BouquetRenderer.distance(point, centre) / gesture.startDistance;
        this.callbacks.onPlace(gesture.instanceId, { scale: clamp(gesture.start.scale * ratio, 0.3, 3) });
      }
    }

    handlePointerEnd(event) {
      const gesture = this.gesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      this.gesture = null;

      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* Already released, or never captured. */
      }

      this.canvas.style.cursor = this.hoveredId ? 'grab' : 'default';
      this.callbacks.onGestureEnd(gesture.instanceId, gesture.moved);
    }

    handlePointerLeave() {
      if (this.gesture || !this.hoveredId) return;
      this.hoveredId = null;
      this.canvas.style.cursor = 'default';
      this.scheduleRender();
    }
  }

  /* ============================================================== Validator */

  /*
    The rules, in one place, phrased for a shopper rather than a developer.

    Flowers and accessories are counted separately: a ribbon is not a stem, so
    it must not use up room in the bouquet or count towards completing it.
  */
  class BouquetValidator {
    constructor(limits) {
      this.minFlowers = limits.minFlowers;
      this.maxFlowers = limits.maxFlowers;
      this.maxAccessories = limits.maxAccessories;
      this.maxPerItem = limits.maxPerItem;
    }

    static tally(state, catalog) {
      let flowers = 0;
      let accessories = 0;
      state.items.forEach((instance) => {
        const item = catalog.get(instance.catalogId);
        if (!item) return;
        if (isAccessory(item)) accessories += 1;
        else flowers += 1;
      });
      return { flowers, accessories };
    }

    canAdd(state, item, catalog) {
      if (!item) return { ok: false, message: '' };
      if (!item.available) return { ok: false, message: `${item.title} is sold out just now.` };

      if (countOf(state, item.id) >= this.maxPerItem) {
        return { ok: false, message: `Up to ${this.maxPerItem} of any one piece, please.` };
      }

      const tally = BouquetValidator.tally(state, catalog);

      if (isAccessory(item)) {
        /*
          One wrap only. Two stacked would put a backing sheet in front of the
          other wrap's front flap, and the bouquet would look torn in half.
        */
        if (item.category === 'wrapper') {
          const wrapped = state.items.some((i) => {
            const held = catalog.get(i.catalogId);
            return held && held.category === 'wrapper';
          });
          if (wrapped) return { ok: false, message: 'A bouquet takes one wrap.' };
        }

        if (tally.accessories >= this.maxAccessories) {
          return { ok: false, message: `Up to ${this.maxAccessories} finishing touches.` };
        }
        return { ok: true, message: '' };
      }

      if (tally.flowers >= this.maxFlowers) {
        return { ok: false, message: `A bouquet holds up to ${this.maxFlowers} flowers.` };
      }

      return { ok: true, message: '' };
    }

    /*
      Progress, not error messages. Below the minimum the customer is told how
      close they are; at it, that they are done and may keep going anyway.
    */
    progress(state, catalog) {
      const { flowers, accessories } = BouquetValidator.tally(state, catalog);
      const complete = flowers >= this.minFlowers;
      const remaining = Math.max(0, this.minFlowers - flowers);

      let headline;
      if (flowers === 0) headline = '';
      else if (!complete) headline = 'Your bouquet is taking shape';
      else if (flowers >= this.maxFlowers) headline = 'A beautifully full bouquet';
      else headline = 'Your bouquet is ready';

      let detail = '';
      if (flowers > 0 && !complete) {
        detail = `Add ${remaining} more flower${remaining === 1 ? '' : 's'} to complete it.`;
      } else if (complete && flowers < this.maxFlowers) {
        detail = 'Add more if you would like a fuller bouquet.';
      }

      return {
        flowers,
        accessories,
        complete,
        remaining,
        /* Counts up to the minimum, then up to the maximum. */
        target: complete ? this.maxFlowers : this.minFlowers,
        headline,
        detail,
        ready: complete,
      };
    }
  }

  /* =================================================================== Cart */

  /*
    The only place that knows a bouquet becomes plain variant lines.

    /cart/add.js takes an items array, so the whole bouquet goes in one round
    trip rather than one request per flower. When this store eventually gets a
    Cart Transform function and the bouquet should arrive as a single bundle
    line, this class is what changes — nothing above it knows the difference.

    Client-side totals are never trusted. Shopify remains authoritative for
    price, discounts, tax and totals; the figure in the summary is UI.
  */
  class BouquetCart {
    constructor() {
      this.cart = document.querySelector('cart-notification') || document.querySelector('cart-drawer');
    }

    get route() {
      return (window.routes && window.routes.cart_add_url) || '/cart/add.js';
    }

    async submit(lines, submitter) {
      const config =
        typeof fetchConfig === 'function'
          ? fetchConfig('javascript')
          : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/javascript' } };

      const body = {
        items: lines.map((line) => ({ id: line.item.variantId, quantity: line.quantity })),
      };

      if (this.cart) {
        body.sections = this.cart.getSectionsToRender().map((section) => section.id);
        body.sections_url = window.location.pathname;
        if (submitter) this.cart.setActiveElement(submitter);
      }

      config.body = JSON.stringify(body);

      const response = await fetch(this.route, config);
      const payload = await response.json();

      /* Shopify signals a rejected add with a `status` on the payload. */
      if (payload.status) {
        throw new Error(payload.description || payload.message || 'This bouquet could not be added.');
      }

      if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
        publish(PUB_SUB_EVENTS.cartUpdate, {
          source: 'bouquet-builder',
          cartData: payload,
        });
      }

      if (!this.cart) {
        window.location = (window.routes && window.routes.cart_url) || '/cart';
        return payload;
      }

      /*
        <cart-notification> was written against a single-item add and reads
        `key` and `id` off the response to find the row it should show. A batch
        add has neither, so we point it at the first line of the bouquet. The
        drawer needs nothing extra.
      */
      const first = Array.isArray(payload.items) ? payload.items[0] : null;
      if (first) {
        if (payload.key === undefined) payload.key = first.key;
        if (payload.id === undefined) payload.id = first.id;
      }

      this.cart.renderContents(payload);
      return payload;
    }
  }

  /* ================================================================ Element */

  class BouquetBuilder extends HTMLElement {
    connectedCallback() {
      this.catalog = BouquetCatalog.fromScript(this.querySelector('[data-bouquet-catalog]'));
      if (this.catalog.isEmpty) return;

      this.resolveNodes();

      this.limits = {
        minFlowers: parseInt(this.dataset.minFlowers, 10) || 0,
        maxFlowers: parseInt(this.dataset.maxFlowers, 10) || 10,
        maxAccessories: parseInt(this.dataset.maxAccessories, 10) || 4,
        maxPerItem: parseInt(this.dataset.maxPerItem, 10) || 6,
      };

      this.store = new BouquetStore();
      this.engine = new BouquetLayoutEngine();
      this.validator = new BouquetValidator(this.limits);
      this.cart = new BouquetCart();
      this.images = new BouquetImageCache(() => this.renderer && this.renderer.scheduleRender());

      this.abilities = {
        drag: this.dataset.enableDrag !== 'false',
        rotate: this.dataset.enableRotate !== 'false',
        scale: this.dataset.enableScale !== 'false',
      };

      this.gestureCheckpointed = false;
      this.submitting = false;
      this.messageTimer = 0;
      this.flashUntil = 0;

      this.mountRenderer();
      this.bindEvents();

      this.filterCards();
      this.warmPickerImages();
      this.unsubscribe = this.store.subscribe((state, reason) => this.sync(reason));
      this.sync('init');
    }

    disconnectedCallback() {
      if (this.unsubscribe) this.unsubscribe();
      this.unsubscribe = null;

      if (this.renderer) this.renderer.destroy();
      this.renderer = null;

      if (this.images) this.images.destroy();
      this.images = null;

      if (this.store) this.store.destroy();
      this.store = null;

      clearTimeout(this.messageTimer);
      if (this.warmHandle) {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this.warmHandle);
        clearTimeout(this.warmHandle);
        this.warmHandle = null;
      }

      if (this.onClick) this.removeEventListener('click', this.onClick);
      if (this.onInput) this.removeEventListener('input', this.onInput);
      this.onClick = null;
      this.onInput = null;
    }

    /* ---------------------------------------------------------------- Setup */

    resolveNodes() {
      this.stage = this.querySelector('[data-bouquet-stage]');
      this.canvas = this.querySelector('[data-bouquet-canvas]');
      this.canvasNote = this.querySelector('[data-bouquet-canvas-note]');

      this.progressHeadline = this.querySelector('[data-bouquet-progress-headline]');
      this.progressCount = this.querySelector('[data-bouquet-progress-count]');
      this.progressDetail = this.querySelector('[data-bouquet-progress-detail]');
      this.progressBar = this.querySelector('[data-bouquet-progress-bar]');
      this.progressTotal = this.querySelector('[data-bouquet-progress-total]');

      this.shuffleButton = this.querySelector('[data-bouquet-shuffle]');
      this.undoButton = this.querySelector('[data-bouquet-undo]');
      this.resetButton = this.querySelector('[data-bouquet-reset]');
      this.forwardButton = this.querySelector('[data-bouquet-forward]');
      this.backwardButton = this.querySelector('[data-bouquet-backward]');

      this.rows = Array.from(this.querySelectorAll('[data-bouquet-row]'));
      this.tabs = Array.from(this.querySelectorAll('[data-bouquet-tab]'));
      this.noResults = this.querySelector('[data-bouquet-no-results]');
      this.searchInput = this.querySelector('[data-bouquet-search]');
      this.cards = Array.from(this.querySelectorAll('[data-bouquet-card]'));

      this.linesList = this.querySelector('[data-bouquet-lines]');
      this.totalNode = this.querySelector('[data-bouquet-total]');
      this.submitButton = this.querySelector('[data-bouquet-submit]');
      this.spinner = this.submitButton ? this.submitButton.querySelector('.loading__spinner') : null;
      this.messageNode = this.querySelector('[data-bouquet-message]');
      this.errorNode = this.querySelector('[data-bouquet-error]');

      /* Each row's own cards, gathered once rather than re-queried per filter. */
      this.rowCards = new Map(this.rows.map((row) => [row, Array.from(row.querySelectorAll('[data-bouquet-card]'))]));

      this.cardIndex = new Map();
      this.cards.forEach((card) => this.cardIndex.set(card.dataset.bouquetCard, card));

      this.searchTerm = '';
      /* Whichever tab the markup marked as pressed, so the two agree from the start. */
      const pressed = this.tabs.find((tab) => tab.getAttribute('aria-pressed') === 'true');
      this.activeCategory = pressed
        ? pressed.dataset.bouquetTab
        : this.rows.length
          ? this.rows[0].dataset.bouquetRow
          : '';
    }

    mountRenderer() {
      if (!this.canvas || !this.stage) return;

      this.renderer = new BouquetRenderer({
        canvas: this.canvas,
        stage: this.stage,
        images: this.images,
        catalog: this.catalog,
        background: this.dataset.background || '',
        abilities: this.abilities,
        callbacks: {
          onSelect: (instanceId) => this.store.dispatch({ type: 'select', instanceId }),
          onRemove: (instanceId) => this.store.dispatch({ type: 'remove', instanceId }),

          onGestureStart: () => {
            this.gestureCheckpointed = false;
          },

          onPlace: (instanceId, placement) => {
            /*
              One undo step per gesture, not one per pointermove — and taken
              lazily, so picking a flower up and putting it straight back down
              does not leave an undo step that appears to do nothing.
            */
            if (!this.gestureCheckpointed) {
              this.store.checkpoint();
              this.gestureCheckpointed = true;
            }
            this.store.dispatch({ type: 'place', instanceId, placement, history: false });
          },

          onGestureEnd: () => this.refreshControls(),
        },
      });

      /*
        No 2D context — an old browser, or one with Canvas switched off. The
        stage stands down and the picker, the list and the cart keep working,
        which is the same path a screen-reader user takes anyway.
      */
      if (!this.renderer.mount()) {
        this.renderer = null;
        this.classList.add('bouquet--no-canvas');
        return;
      }

      if (this.dataset.background) this.images.get(this.dataset.background);
    }

    bindEvents() {
      this.onClick = this.handleClick.bind(this);
      this.onInput = this.handleInput.bind(this);
      this.addEventListener('click', this.onClick);
      this.addEventListener('input', this.onInput);
    }

    /* --------------------------------------------------------------- Events */

    handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      const add = target.closest('[data-bouquet-add], [data-bouquet-increase]');
      if (add && this.contains(add)) {
        this.addItem(add.dataset.bouquetAdd || add.dataset.bouquetIncrease);
        return;
      }

      const decrease = target.closest('[data-bouquet-decrease]');
      if (decrease && this.contains(decrease)) {
        this.store.dispatch({ type: 'removeLastOf', catalogId: decrease.dataset.bouquetDecrease });
        return;
      }

      const removeLine = target.closest('[data-bouquet-remove-line]');
      if (removeLine && this.contains(removeLine)) {
        this.store.dispatch({ type: 'removeAllOf', catalogId: removeLine.dataset.bouquetRemoveLine });
        return;
      }

      const tab = target.closest('[data-bouquet-tab]');
      if (tab && this.contains(tab)) {
        this.activeCategory = tab.dataset.bouquetTab;
        this.tabs.forEach((button) => button.setAttribute('aria-pressed', String(button === tab)));
        this.filterCards();
        return;
      }

      if (target.closest('[data-bouquet-shuffle]')) {
        /*
          The only thing in the whole builder that may produce a new
          arrangement. Everything else — resize, filter, quantity, price, cart —
          leaves the bouquet exactly where it is.
        */
        this.store.dispatch({ type: 'shuffle', seed: randomSeed() });
        return;
      }

      if (target.closest('[data-bouquet-forward]')) {
        this.restack(1);
        return;
      }

      if (target.closest('[data-bouquet-backward]')) {
        this.restack(-1);
        return;
      }

      if (target.closest('[data-bouquet-undo]')) {
        this.store.undo();
        return;
      }

      if (target.closest('[data-bouquet-reset]')) {
        this.store.dispatch({ type: 'reset', seed: randomSeed() });
        this.announce('');
        return;
      }

      const submit = target.closest('[data-bouquet-submit]');
      if (submit && this.contains(submit)) this.submit(submit);
    }

    handleInput(event) {
      if (event.target !== this.searchInput) return;
      this.searchTerm = this.searchInput.value.trim().toLowerCase();
      this.filterCards();
    }

    addItem(catalogId) {
      const item = this.catalog.get(catalogId);
      const verdict = this.validator.canAdd(this.store.getState(), item, this.catalog);

      if (!verdict.ok) {
        this.announce(verdict.message, { flash: true });
        return;
      }

      /* A successful add retires whatever refusal was on screen. */
      this.flashUntil = 0;

      this.store.dispatch({
        type: 'add',
        instanceId: this.store.nextInstanceId(),
        catalogId,
      });
    }

    /* ---------------------------------------------------------- Subscribers */

    sync(reason) {
      const state = this.store.getState();

      /*
        The arrangement is recomputed from (items, seed) on every change. It is
        pure, so an add or a removal repositions only what it must, and a
        re-render with the same seed reproduces the same bouquet exactly.
      */
      if (this.renderer) {
        this.renderer.setArrangement(
          this.engine.arrange(state.items, this.catalog, state.seed),
          reason,
          state.selectedId,
        );
      }

      this.syncPicker(state);
      this.syncProgress(state);
      this.syncSummary(state);

      this.refreshControls();

      if (this.canvasNote) this.canvasNote.hidden = !this.renderer || state.items.length === 0;
    }

    /*
      Undo, start over, shuffle, and the two layer buttons. The layer buttons
      only mean anything while something is selected, so they say so rather than
      sitting there looking available.
    */
    refreshControls() {
      const state = this.store.getState();
      const selected = Boolean(state.selectedId);

      if (this.undoButton) this.undoButton.disabled = !this.store.canUndo;
      if (this.resetButton) this.resetButton.disabled = state.items.length === 0;
      if (this.shuffleButton) this.shuffleButton.disabled = state.items.length < 2;

      [this.forwardButton, this.backwardButton].forEach((button) => {
        if (button) button.disabled = !selected;
      });
      this.classList.toggle('bouquet--has-selection', selected);
    }

    /* Move the selected piece one step towards the front, or the back. */
    restack(by) {
      const state = this.store.getState();
      if (!state.selectedId || !this.renderer) return;

      const current = this.renderer.arrangement.find((t) => t.instanceId === state.selectedId);
      if (!current) return;

      this.store.dispatch({
        type: 'restack',
        instanceId: state.selectedId,
        baseLayer: Number.isFinite(current.baseLayer) ? current.baseLayer : current.layer,
        by,
      });
    }

    syncPicker(state) {
      const tally = BouquetValidator.tally(state, this.catalog);

      this.cardIndex.forEach((card, catalogId) => {
        const quantity = countOf(state, catalogId);
        const stepper = card.querySelector('[data-bouquet-stepper]');
        const addButton = card.querySelector('[data-bouquet-add]');
        const quantityNode = card.querySelector('[data-bouquet-quantity]');

        card.classList.toggle('bouquet-card--chosen', quantity > 0);
        if (quantityNode) quantityNode.textContent = String(quantity);
        if (stepper) stepper.hidden = quantity === 0;
        if (addButton) addButton.hidden = quantity > 0;

        const increase = card.querySelector('[data-bouquet-increase]');
        if (increase) {
          const item = this.catalog.get(catalogId);
          const full =
            item && isAccessory(item)
              ? tally.accessories >= this.limits.maxAccessories
              : tally.flowers >= this.limits.maxFlowers;
          increase.disabled = quantity >= this.limits.maxPerItem || full;
        }
      });
    }

    syncProgress(state) {
      const progress = this.validator.progress(state, this.catalog);
      const total = calculateTotal(state, this.catalog);

      if (this.progressHeadline) {
        /* Empty until there is something to say — the line disappears with `:empty`. */
        this.progressHeadline.textContent = progress.headline;
      }
      if (this.progressCount) {
        this.progressCount.textContent = `${progress.flowers} / ${progress.target} flowers`;
        this.progressCount.hidden = progress.flowers === 0;
      }
      if (this.progressDetail) {
        this.progressDetail.textContent = progress.detail;
        this.progressDetail.hidden = !progress.detail;
      }
      if (this.progressTotal) {
        this.progressTotal.textContent = this.catalog.money(total);
        this.progressTotal.hidden = state.items.length === 0;
      }
      if (this.progressBar) {
        const ratio = progress.target ? Math.min(1, progress.flowers / progress.target) : 0;
        this.progressBar.style.setProperty('--bouquet-progress', String(ratio));
        this.progressBar.hidden = progress.flowers === 0;
      }

      this.classList.toggle('bouquet--ready', progress.ready);
    }

    syncSummary(state) {
      const lines = deriveLines(state, this.catalog);

      if (this.linesList) this.linesList.replaceChildren(...lines.map((line) => this.buildLine(line)));
      if (this.totalNode) this.totalNode.textContent = this.catalog.money(calculateTotal(state, this.catalog));

      const progress = this.validator.progress(state, this.catalog);
      if (this.submitButton) {
        const blocked = !progress.ready || this.submitting;
        this.submitButton.disabled = blocked;
        this.submitButton.setAttribute('aria-disabled', String(blocked));
      }

      /*
        The standing guidance lives in the progress block, so this slot is only
        for things the customer just earned — a refusal, or a confirmation.
      */
      if (!this.submitting && Date.now() >= (this.flashUntil || 0) && this.messageNode) {
        this.messageNode.textContent = '';
      }
    }

    /*
      One compact chip per variant in the bouquet: what it is, how many, and a
      way to take it out. Deliberately not a row with a thumbnail, a price and a
      stepper — that grows into a wall of text as the bouquet fills, and the
      quantity controls already live on the picker card where the choosing
      happens. The chip is still a real button, so a keyboard or screen-reader
      user can empty a line without touching the Canvas.
    */
    buildLine(line) {
      const li = document.createElement('li');
      li.className = 'bouquet-line';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bouquet-line__chip';
      button.dataset.bouquetRemoveLine = line.item.id;

      const name = document.createElement('span');
      name.className = 'bouquet-line__name';
      name.textContent = line.item.variantTitle ? `${line.item.title} · ${line.item.variantTitle}` : line.item.title;
      button.appendChild(name);

      if (line.quantity > 1) {
        const count = document.createElement('span');
        count.className = 'bouquet-line__count';
        count.textContent = `×${line.quantity}`;
        button.appendChild(count);
      }

      const cross = document.createElement('span');
      cross.className = 'bouquet-line__cross';
      cross.setAttribute('aria-hidden', 'true');
      cross.textContent = '×';
      button.appendChild(cross);

      button.setAttribute('aria-label', `Remove ${line.quantity} ${line.item.title} from your bouquet`);

      li.appendChild(button);
      return li;
    }

    announce(message, options) {
      if (!this.messageNode) return;
      const settings = options || {};

      clearTimeout(this.messageTimer);
      this.messageNode.textContent = message || '';
      this.flashUntil = message && settings.flash ? Date.now() + FLASH_MS : 0;

      if (message && !settings.persist) {
        this.messageTimer = setTimeout(() => {
          if (this.messageNode) this.messageNode.textContent = '';
          this.flashUntil = 0;
        }, FLASH_MS);
      }
    }

    showError(message) {
      if (!this.errorNode) return;
      this.errorNode.textContent = message || '';
      this.errorNode.hidden = !message;
    }

    /* ----------------------------------------------------------------- Cart */

    async submit(button) {
      if (this.submitting) return;

      const state = this.store.getState();
      const progress = this.validator.progress(state, this.catalog);
      if (!progress.ready) {
        this.announce(progress.detail, { flash: true });
        return;
      }

      const lines = deriveLines(state, this.catalog);
      if (!lines.length) return;

      this.submitting = true;
      this.showError('');
      this.setBusy(true);

      try {
        await this.cart.submit(lines, button);
        this.store.dispatch({ type: 'reset', seed: randomSeed() });
        this.announce('Your bouquet is in the cart.', { flash: true });
      } catch (error) {
        this.showError(
          error && error.message ? error.message : 'Your bouquet could not be added just now. Please try again.',
        );
      } finally {
        this.submitting = false;
        this.setBusy(false);
        this.sync('cart');
      }
    }

    setBusy(busy) {
      if (this.submitButton) {
        this.submitButton.classList.toggle('loading', busy);
        this.submitButton.disabled = busy;
        this.submitButton.setAttribute('aria-disabled', String(busy));
      }
      if (this.spinner) this.spinner.classList.toggle('hidden', !busy);
    }

    /* --------------------------------------------------------------- Filter */

    /*
      One row on show at a time — that is what keeps the section from running
      to twice the height of the bouquet beside it.

      Searching is the deliberate exception: a customer typing "rose" wants it
      found wherever it lives, so a search reaches across every kind and shows
      each row that still has something in it. Clearing the box returns to the
      chosen tab.
    */
    /*
      Only the chosen row is on show, and only what actually changes is written.

      Setting `hidden` on all forty cards on every tab press, and asking each row
      to re-query its own children, made switching kinds cost far more than it
      needed to. The row's cards are collected once instead, and a value is only
      assigned when it differs from what is already there.
    */
    filterCards() {
      const searching = this.searchTerm.length > 0;
      let visible = 0;

      this.cardIndex.forEach((card) => {
        const show = !searching || (card.dataset.bouquetSearchText || '').includes(this.searchTerm);
        if (card.hidden === show) card.hidden = !show;
        if (show) visible += 1;
      });

      this.rows.forEach((row) => {
        const cards = this.rowCards.get(row) || [];
        const matches = cards.some((card) => !card.hidden);
        const hide = searching ? !matches : row.dataset.bouquetRow !== this.activeCategory;
        if (row.hidden !== hide) row.hidden = hide;
      });

      if (this.noResults) this.noResults.hidden = visible > 0;
    }

    /*
      Fetch every picker thumbnail once the page has settled.

      The cards are lazy-loaded, and a card in a row that has never been on show
      has never been near the viewport — so choosing that kind for the first time
      started the fetch right then, and the row flashed through blank cards
      before the pictures arrived. Warming them on idle costs nothing at the
      moment it matters and makes every tab after the first appear at once.
    */
    warmPickerImages() {
      const images = Array.from(this.querySelectorAll('.bouquet-card__image[loading="lazy"]'));
      if (!images.length) return;

      const warm = () => images.forEach((image) => image.setAttribute('loading', 'eager'));

      /* After the Canvas and the first row have had the network to themselves. */
      if (typeof requestIdleCallback === 'function') {
        this.warmHandle = requestIdleCallback(warm, { timeout: 2000 });
      } else {
        this.warmHandle = setTimeout(warm, 400);
      }
    }
  }

  customElements.define('bouquet-builder', BouquetBuilder);
})();
