import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);
const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
const subscribe = (listener: () => void) => { preference.addEventListener('change', listener); return () => preference.removeEventListener('change', listener); };
export function useReducedMotion() { return useSyncExternalStore(subscribe, () => preference.matches, () => true); }

const timing = { enter: 0.26, feedback: 0.28, expand: 0.2 };
const ease = 'power2.out';

export function HeadingAccent() {
  const target = useRef<HTMLSpanElement>(null); const reduced = useReducedMotion();
  useGSAP(() => {
    if (!reduced && target.current) gsap.fromTo(target.current, { scaleX: 0.35 }, { scaleX: 1, duration: timing.enter, ease, clearProps: 'transform' });
  }, { scope: target, dependencies: [reduced], revertOnUpdate: true });
  return <span ref={target} className="heading-accent" aria-hidden="true" />;
}

export function StateMarker({ value }: { value: string }) {
  const target = useRef<HTMLSpanElement>(null); const previous = useRef(value); const reduced = useReducedMotion();
  useGSAP(() => {
    const changed = previous.current !== value; previous.current = value;
    // Only an actual server state change triggers feedback, never a poll or display-language change.
    if (!reduced && changed && target.current) gsap.fromTo(target.current, { scale: 1.45 }, { scale: 1, duration: timing.feedback, ease, clearProps: 'transform' });
  }, { scope: target, dependencies: [value, reduced], revertOnUpdate: true });
  return <span ref={target} className="state-marker" data-state={value} aria-hidden="true" />;
}

export function useNewEventMotion(sequences: readonly number[]) {
  const scope = useRef<HTMLOListElement>(null); const previous = useRef<Set<number> | null>(null); const reduced = useReducedMotion();
  const key = sequences.join(',');
  useGSAP(() => {
    const current = new Set(sequences); const added = previous.current ? sequences.filter(value => !previous.current!.has(value)).slice(-3) : [];
    previous.current = current;
    if (reduced || !scope.current || !added.length) return;
    const targets = [...scope.current.querySelectorAll<HTMLElement>('[data-event-sequence]')].filter(element => added.includes(Number(element.dataset.eventSequence)));
    gsap.fromTo(targets, { scale: 1.25 }, { scale: 1, duration: timing.feedback, ease, stagger: 0.03, clearProps: 'transform' });
  }, { scope, dependencies: [key, reduced], revertOnUpdate: true });
  return scope;
}

export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const scope = useRef<HTMLDetailsElement>(null); const content = useRef<HTMLDivElement>(null); const reduced = useReducedMotion();
  const { contextSafe } = useGSAP(() => {}, { scope, dependencies: [reduced], revertOnUpdate: true });
  const toggle = contextSafe(() => {
    if (!content.current) return;
    gsap.killTweensOf(content.current);
    // Native details toggles immediately. This decoration never holds old private content for an exit.
    if (scope.current?.open && !reduced) gsap.fromTo(content.current, { y: -4 }, { y: 0, duration: timing.expand, ease, clearProps: 'transform' });
    else if (content.current.style.transform) gsap.set(content.current, { clearProps: 'transform' });
  });
  return <details ref={scope} onToggle={toggle}><summary>{title}</summary><div ref={content} className="disclosure-content">{children}</div></details>;
}
