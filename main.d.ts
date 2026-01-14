import { Plugin } from 'obsidian';
interface GhostPublisherSettings {
    blogUrl: string;
    writingFolderPath: string;
    ghostApiKeyName: string;
}
export default class ObsidianToGhostPublisher extends Plugin {
    settings: GhostPublisherSettings;
    onload(): Promise<void>;
    onunload(): void;
    loadSettings(): Promise<void>;
    saveSettings(): Promise<void>;
}
export {};
