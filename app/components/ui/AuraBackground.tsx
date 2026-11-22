import React from 'react';

export interface AuraBackgroundProps {
  children?: React.ReactNode;
  className?: string;
}

/**
 * Calm dark mode application wrapper.
 */
export function AuraBackground({ children, className = '' }: AuraBackgroundProps) {
  return (
    <div className={`aura-bg ${className}`.trim()}>
      <div className="aura-content">
        {children}
      </div>
    </div>
  );
}

export default AuraBackground;
