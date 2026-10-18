import React from 'react';

export interface AuraBackgroundProps {
  children?: React.ReactNode;
  className?: string;
}

/**
 * Aura Gradient: "Eclipse Flare"
 * A vivid atmospheric gradient background using layered CSS blend modes over a dark backdrop (#100e0b).
 */
export function AuraBackground({ children, className = '' }: AuraBackgroundProps) {
  return (
    <div className={`aura-bg ${className}`.trim()}>
      <div className="aura-layer-1" aria-hidden="true" />
      <div className="aura-layer-2" aria-hidden="true" />
      {/* Page content sits above the layers */}
      <div className="aura-content">
        {children}
      </div>
    </div>
  );
}

export default AuraBackground;

