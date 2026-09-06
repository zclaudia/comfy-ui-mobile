import React from 'react';
import { useNavigate } from 'react-router-dom';
import SideMenu from '@/components/controls/SideMenu';

/** SideMenu with navigation-only handlers, for pages that have no workflow-specific menu actions. */
const AppSideMenu: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const go = (path: string) => { onClose(); sessionStorage.setItem('app-navigation', 'true'); navigate(path); };
  return (
    <SideMenu
      isOpen={isOpen}
      onClose={onClose}
      onServerSettingsClick={() => go('/settings/server')}
      onApiKeysClick={() => go('/settings/api-keys')}
      onImportWorkflowsClick={() => go('/import/server')}
      onUploadWorkflowsClick={() => go('/upload/server')}
      onServerRebootClick={() => go('/reboot')}
      onModelDownloadClick={() => go('/models/download')}
      onModelBrowserClick={() => go('/models/browser')}
      onBrowserDataBackupClick={() => go('/browser-data-backup')}
      onWidgetTypeSettingsClick={() => go('/settings/widget-types')}
      onVideoDownloadClick={() => go('/videos/download')}
      onChainsClick={() => go('/chains')}
    />
  );
};
export default AppSideMenu;
