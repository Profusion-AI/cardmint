import React from 'react';
import PropTypes from 'prop-types';

/**
 * Simple funnel visualization component
 * Uses pure CSS for bar rendering - no external charting dependencies
 */
export default function FunnelChart({ steps }) {
  if (!steps || steps.length === 0) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        No funnel data available
      </div>
    );
  }

  const maxCount = Math.max(...steps.map(s => s.count), 1);

  return (
    <div style={{ padding: '20px' }}>
      {steps.map((step, index) => {
        const widthPercent = (step.count / maxCount) * 100;
        const isLast = index === steps.length - 1;

        return (
          <div
            key={step.event}
            style={{
              marginBottom: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span style={{ fontWeight: 500 }}>{step.label}</span>
              <span style={{ color: '#666' }}>
                {step.count.toLocaleString()} ({step.conversion_rate}%)
              </span>
            </div>
            <div
              style={{
                height: '24px',
                backgroundColor: '#f0f0f0',
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${widthPercent}%`,
                  backgroundColor: isLast ? '#4ADC61' : '#0A203F',
                  borderRadius: '4px',
                  transition: 'width 0.3s ease',
                  minWidth: step.count > 0 ? '2px' : '0',
                }}
              />
            </div>
            {index < steps.length - 1 && (
              <div style={{ textAlign: 'center', color: '#999', fontSize: '12px' }}>
                ↓ {steps[index + 1].conversion_rate}% conversion
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

FunnelChart.propTypes = {
  steps: PropTypes.arrayOf(
    PropTypes.shape({
      event: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      count: PropTypes.number.isRequired,
      conversion_rate: PropTypes.number.isRequired,
    })
  ),
};

FunnelChart.defaultProps = {
  steps: [],
};
