import React, { useState } from 'react';
import { PageHeader } from '@/components/navigation/PageHeader';
import { WidgetTypeSettings } from '../etc/WidgetTypeSettings';
import { NodePatch } from '../etc/NodePatch';
import { useTranslation } from 'react-i18next';

export const CustomTypeManager: React.FC = () => {
  const { t } = useTranslation();
  const [currentTab, setCurrentTab] = useState<'widget-types' | 'node-mappings'>('widget-types');

  return (
    <div
      className="pwa-container transition-colors duration-300"
      style={{
        overflow: 'hidden',
        height: '100dvh',
        maxHeight: '100dvh',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0
      }}
    >
      <div className="absolute inset-0 bg-[#0b0c0f]" />

      {/* Main Scrollable Content Area */}
      <div
        className="absolute top-0 left-0 right-0 bottom-0"
        style={{
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch'
        }}
      >
        <PageHeader title={t('customTypes.title')} subtitle={t('customTypes.subtitle')}>
          {/* Tab Navigation lives inside the sticky header so it never drifts from it */}
          <div className="flex gap-6 px-4 border-t border-white/[0.06]">
            {([['widget-types', 'customTypes.tabWidgetTypes'], ['node-mappings', 'customTypes.tabNodePatches']] as const).map(([tab, key]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setCurrentTab(tab)}
                className={`py-3 px-1 -mb-px border-b-2 text-[12.5px] font-semibold transition-colors ${currentTab === tab
                  ? 'border-[#5b8af5] text-[#e9ebef]'
                  : 'border-transparent text-[#71798a] hover:text-[#c8ccd4]'
                  }`}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </PageHeader>

        {/* Tab Content */}
        <main className="p-4 pb-20">
          {currentTab === 'widget-types' ? (
            <WidgetTypeSettings />
          ) : (
            <NodePatch />
          )}
        </main>
      </div>
    </div>
  );
};