'use client';

import { useRef, useState } from 'react';

interface UseGlassSliderOptions {
  count: number;
  activeIndex: number;
  stepPx?: number;
  axis?: 'y' | 'x';
  onSelectIndex: (index: number) => void;
}

/**
 * Enables press-and-drag (touch or mouse) sliding of a vertical or horizontal
 * Liquid Glass indicator pill across menu items while preserving normal clicks.
 */
export function useGlassSlider({
  count,
  activeIndex,
  stepPx = 45,
  axis = 'y',
  onSelectIndex,
}: UseGlassSliderOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const dragState = useRef<{
    active: boolean;
    didDrag: boolean;
    pointerId: number;
    startCoord: number;
    startOffset: number;
    currentOffset: number;
    effectiveStep: number;
  }>({
    active: false,
    didDrag: false,
    pointerId: -1,
    startCoord: 0,
    startOffset: 0,
    currentOffset: 0,
    effectiveStep: stepPx,
  });

  const justDraggedRef = useRef(false);
  const externalTargetRef = useRef<number | null>(null);

  const resolveStep = () => {
    if (axis === 'x') {
      const w = containerRef.current?.clientWidth || 0;
      if (w > 0 && count > 0) return w / count;
    }
    return stepPx || 45;
  };

  const updateExternalClientY = (clientY: number | null) => {
    if (clientY === null) {
      externalTargetRef.current = null;
      setDragOffset(null);
      setPreviewIndex(null);
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const step = resolveStep();
    const maxOffset = Math.max(0, (count - 1) * step);
    const clamped = Math.max(0, Math.min(maxOffset, clientY - rect.top - step / 2));
    const idx = Math.max(0, Math.min(count - 1, Math.round(clamped / step)));
    externalTargetRef.current = idx;
    setDragOffset(clamped);
    setPreviewIndex(idx);
  };

  const commitExternal = (shouldSelect: boolean) => {
    const target = externalTargetRef.current;
    externalTargetRef.current = null;
    setDragOffset(null);
    setPreviewIndex(null);
    if (shouldSelect && target !== null) {
      onSelectIndex(target);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (count <= 1 || activeIndex < 0) return;

    const effectiveStep = resolveStep();
    const startOffset = activeIndex * effectiveStep;
    dragState.current = {
      active: true,
      didDrag: false,
      pointerId: e.pointerId,
      startCoord: axis === 'x' ? e.clientX : e.clientY,
      startOffset,
      currentOffset: startOffset,
      effectiveStep,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st.active || st.pointerId !== e.pointerId) return;

    const delta = (axis === 'x' ? e.clientX : e.clientY) - st.startCoord;
    if (!st.didDrag) {
      if (Math.abs(delta) < 5) return;
      st.didDrag = true;
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // ignore if element cannot capture
      }
    }

    const maxOffset = Math.max(0, (count - 1) * st.effectiveStep);
    const clamped = Math.max(0, Math.min(maxOffset, st.startOffset + delta));
    st.currentOffset = clamped;
    setDragOffset(clamped);
    setPreviewIndex(Math.round(clamped / st.effectiveStep));
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const st = dragState.current;
    if (!st.active || st.pointerId !== e.pointerId) return;
    st.active = false;

    if (st.didDrag) {
      try {
        if (containerRef.current?.hasPointerCapture(e.pointerId)) {
          containerRef.current.releasePointerCapture(e.pointerId);
        }
      } catch {
        // ignore
      }
      const targetIndex = Math.max(0, Math.min(count - 1, Math.round(st.currentOffset / st.effectiveStep)));
      setDragOffset(null);
      setPreviewIndex(null);
      justDraggedRef.current = true;
      window.setTimeout(() => {
        justDraggedRef.current = false;
      }, 60);

      if (!cancelled) {
        onSelectIndex(targetIndex);
      }
    }
  };

  const effectiveIndex = previewIndex ?? activeIndex;
  const sliderY = dragOffset !== null ? `${dragOffset}px` : `${Math.max(0, activeIndex) * stepPx}px`;
  const sliderX = dragOffset !== null ? `${dragOffset}px` : `${Math.max(0, activeIndex) * 100}%`;

  return {
    containerRef,
    isDragging: dragOffset !== null,
    effectiveIndex,
    sliderY,
    sliderX,
    justDraggedRef,
    updateExternalClientY,
    commitExternal,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => finishDrag(e, false),
      onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => finishDrag(e, true),
    },
  };
}
