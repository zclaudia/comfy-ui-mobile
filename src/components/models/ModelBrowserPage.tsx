import React from 'react';
import { useConnectionStore } from '@/ui/store/connectionStore';
import ModelBrowser from './ModelBrowser';
import { resolveGatewayUrl } from '@/config/runtime';

const ModelBrowserPage: React.FC = () => {
  const { url } = useConnectionStore();
  
  return <ModelBrowser serverUrl={resolveGatewayUrl(url)} />;
};

export default ModelBrowserPage;
