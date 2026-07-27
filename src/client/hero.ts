// Landing-page motion. Bundled to a minified IIFE by scripts/build-client.mjs
// and inlined into the page; it never loads on /dossier or /dossier/sample,
// which are documents people print.
//
// The loop is one timeline with named labels matching the brief's beats, so any
// phase can be inspected with tl.seek("verdict"). It ends in exactly the state
// it starts, so the repeat is invisible.
//
// Motion language: the engine is deterministic and reproducible, so the motion
// snaps. power4/expo easing, hard stops, no drift, no organic wobble. An
// instrument taking a reading.

import gsap from "gsap";
import Lenis from "lenis";

const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T | null;
const qa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

// ── smooth scroll ───────────────────────────────────────────────────────────
// Reduced motion turns Lenis off entirely rather than shortening it: hijacked
// scrolling is itself the accessibility problem, so the fix is native scroll.
function initScroll(reduced: boolean): Lenis | null {
  const anchors = qa<HTMLAnchorElement>('a[href^="#"]');

  if (reduced) {
    // Native scrolling already handles anchors and the initial hash.
    return null;
  }

  const lenis = new Lenis({ duration: 0.9, smoothWheel: true });
  lenis.on("scroll", () => ScrollTriggerUpdate());
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);

  // In-page anchors do not work under Lenis unless routed through scrollTo.
  // #use is linked publicly, so both paths have to work: clicked, and loaded
  // cold with the hash already in the URL.
  for (const a of anchors) {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (!id || id === "#") return;
      const target = q(id);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -20 });
      history.pushState(null, "", id);
    });
  }
  if (location.hash) {
    const target = q(location.hash);
    if (target) requestAnimationFrame(() => lenis.scrollTo(target, { immediate: true, offset: -20 }));
  }
  return lenis;
}

// No ScrollTrigger in this build: the hero is a self-contained loop, not
// scroll-driven, so the plugin would be 15KB of decoration. This stub keeps the
// Lenis wiring honest about what it would call if that changes.
function ScrollTriggerUpdate(): void {}

// ── the hero loop ───────────────────────────────────────────────────────────
const STATIONS = 5;

function buildTimeline(root: HTMLElement, reduced: boolean): gsap.core.Timeline | null {
  const ring = q<SVGPathElement>(".h-ring-arc", root);
  const probes = qa<SVGLineElement>(".h-probe", root);
  // Two views of the same five stations: dots on the ring for wide screens,
  // dots beside the stacked labels below 640px. Only one is visible at a time
  // (CSS), and both are tweened, so the sequence reads the same either way.
  const dots = qa(".h-dot", root);
  const ldots = qa(".h-ldot", root);
  const station = (i: number) => [dots[i], ldots[i]].filter(Boolean) as Element[];
  const labels = qa(".h-label", root);
  const addr = q(".h-addr", root);
  const verdict = q(".h-verdict", root);
  const figures = qa(".h-fig", root);
  if (!ring || !addr || !verdict || probes.length !== STATIONS) return null;

  // One source is unavailable, so confidence is 4/5. The arc is visibly short
  // of closed, which is the whole point: the product does not claim knowledge
  // it does not have.
  const LEN = ring.getTotalLength();
  const CONFIDENCE = 0.8;

  const rest = () => {
    gsap.set([probes, dots, ldots], { opacity: 0 });
    gsap.set(probes, { scaleX: 0, transformOrigin: "0% 50%" });
    gsap.set([dots, ldots], { scale: 0.4 });
    gsap.set(labels, { opacity: 0.28 });
    gsap.set([verdict, figures], { opacity: 0 });
    gsap.set(addr, { opacity: 0, y: 6 });
    gsap.set(ring, { strokeDasharray: LEN, strokeDashoffset: LEN });
  };

  if (reduced) {
    // One composed still: the most informative frame, not a blank box.
    gsap.set([probes, dots, ldots, labels, verdict, figures, addr], { opacity: 1 });
    gsap.set(probes, { scaleX: 1 });
    gsap.set([dots, ldots], { scale: 1 });
    gsap.set(addr, { y: 0 });
    gsap.set(ring, { strokeDasharray: LEN, strokeDashoffset: LEN * (1 - CONFIDENCE) });
    gsap.set(station(3), { scale: 0.82 });
    return null;
  }

  rest();
  const tl = gsap.timeline({ repeat: -1, defaults: { ease: "power4.out" } });

  tl.addLabel("arrive")
    .to(addr, { opacity: 1, y: 0, duration: 0.5 })
    .to(labels, { opacity: 0.55, duration: 0.4, stagger: 0.05 }, "<0.1")
    .to({}, { duration: 1.4 });

  tl.addLabel("dispatch")
    // Staggered, never all five at once: the engine fans out to five checks.
    .to(probes, { opacity: 1, scaleX: 1, duration: 0.6, stagger: 0.68, ease: "expo.out" })
    .to({}, { duration: 0.68 });

  tl.addLabel("resolve");
  dots.forEach((_dot, i) => {
    const unavailable = i === 3;
    tl.to(
      station(i),
      {
        opacity: 1,
        scale: unavailable ? 0.82 : 1,
        duration: 0.32,
        ease: "power4.out",
      },
      `resolve+=${i * 0.8}`,
    ).to(
      labels[i] ?? {},
      { opacity: unavailable ? 0.5 : 1, duration: 0.3 },
      `resolve+=${i * 0.8}`,
    );
  });
  tl.to({}, { duration: 0.48 }, "resolve+=3.52");

  tl.addLabel("verdict")
    .to(ring, { strokeDashoffset: LEN * (1 - CONFIDENCE), duration: 1.2, ease: "expo.out" })
    .to(verdict, { opacity: 1, duration: 0.4 }, "<0.35")
    .to(figures, { opacity: 1, duration: 0.35, stagger: 0.08 }, "<0.1")
    .to({}, { duration: 0.45 });

  // The hold is the payoff, not dead time: it reads as a finished report.
  tl.addLabel("hold").to({}, { duration: 3.0 });

  tl.addLabel("return")
    .to([verdict, figures, addr], { opacity: 0, duration: 0.35, ease: "power2.in" })
    .to([dots, ldots], { opacity: 0, scale: 0.4, duration: 0.3, ease: "power2.in" }, "<")
    .to(probes, { scaleX: 0, opacity: 0, duration: 0.4, ease: "power2.in" }, "<0.05")
    .to(ring, { strokeDashoffset: LEN, duration: 0.6, ease: "power2.in" }, "<")
    .to({}, { duration: 0.35 })
    .to(labels, { opacity: 0.28, duration: 0.3 }, "<")
    .set(addr, { y: 6 });

  return tl;
}

function init(): void {
  const root = q(".hero-viz");
  if (!root) return;

  gsap.matchMedia().add(
    {
      motion: "(prefers-reduced-motion: no-preference)",
      reduced: "(prefers-reduced-motion: reduce)",
    },
    (ctx) => {
      const reduced = !!ctx.conditions?.reduced;
      const lenis = initScroll(reduced);
      const tl = buildTimeline(root, reduced);
      if (!tl) return () => lenis?.destroy();

      // Idle when it cannot be seen: hidden tab, or scrolled past.
      const onVisibility = () => (document.hidden ? tl.pause() : tl.resume());
      document.addEventListener("visibilitychange", onVisibility);
      const io = new IntersectionObserver(
        ([e]) => (e && e.isIntersecting && !document.hidden ? tl.resume() : tl.pause()),
        { threshold: 0.05 },
      );
      io.observe(root);

      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        io.disconnect();
        tl.kill();
        lenis?.destroy();
        gsap.ticker.lagSmoothing(500, 33);
      };
    },
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
