import { App, Plugin, PluginSettingTab, Setting, Notice, request, TFile } from 'obsidian';
import { sign } from 'jsonwebtoken';

// Define the settings interface
interface GhostPublisherSettings {
  blogUrl: string;
  writingFolderPath: string;
  ghostApiKeyName: string; // New setting
}

// Define the default settings
const DEFAULT_SETTINGS: GhostPublisherSettings = {
  blogUrl: '',
  writingFolderPath: 'writing',
  ghostApiKeyName: 'ghost-admin-api-key', // Default for new setting
};

// ADDED: JWT generation function
function generateGhostAdminToken(apiKey: string): string | null {
  const [id, secret] = apiKey.split(':');
  if (!id || !secret) {
    return null;
  }
  const token = sign({}, Buffer.from(secret, 'hex'), {
    keyid: id,
    algorithm: 'HS256',
    expiresIn: '5m',
    audience: '/admin/'
  });
  return token;
}

export default class ObsidianToGhostPublisher extends Plugin {
  settings!: GhostPublisherSettings;

  async onload() {
    console.log('loading Obsidian to Ghost Publisher plugin');

    // Load settings
    await this.loadSettings();

    // Add the settings tab
    this.addSettingTab(new GhostSettingsTab(this.app, this));

    // Add a command to publish to Ghost
    this.addCommand({
      id: 'publish-to-ghost',
      name: 'Publish to Ghost',
      callback: async () => {
        // 1. Get Settings
        const { blogUrl, ghostApiKeyName } = this.settings;
        if (!blogUrl || !ghostApiKeyName) {
          new Notice('Blog URL and API Key Name must be set in settings.');
          return;
        }

        try {
          // 2. Get API Key
          const apiKey = await this.app.secretStorage.getSecret(ghostApiKeyName);
          if (!apiKey) {
            new Notice(`API Key secret named '${ghostApiKeyName}' not found.`);
            return;
          }

          // 3. Generate JWT
          const token = generateGhostAdminToken(apiKey);
          if (!token) {
            new Notice('API Key is not in the correct format (id:secret).');
            return;
          }

          // 4. Make API Request
          const normalizedUrl = blogUrl.replace(/\/$/, '');
          const apiUrl = `${normalizedUrl}/ghost/api/admin/posts/`;

          new Notice('Attempting to authenticate with Ghost...');
          
          const response = await request({
            url: apiUrl,
            method: 'GET',
            headers: {
              'Authorization': `Ghost ${token}`
            }
          });
          
          const responseData = JSON.parse(response);
          
          new Notice(`Successfully authenticated! Found ${responseData.posts.length} posts.`, 10000);
          console.log('Ghost Posts:', responseData);

        } catch (error) {
          console.error('Error authenticating with Ghost:', error);
          new Notice('Error authenticating with Ghost. Check settings and API key.', 10000);
        }
      },
    });
  }

  onunload() {
    console.log('unloading Obsidian to Ghost Publisher plugin');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class GhostSettingsTab extends PluginSettingTab {
  plugin: ObsidianToGhostPublisher;

  constructor(app: App, plugin: ObsidianToGhostPublisher) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Ghost Publisher Settings' });

    new Setting(containerEl)
      .setName('Blog URL')
      .setDesc('The public URL of your Ghost blog (e.g., https://myblog.com)')
      .addText(text => text
        .setPlaceholder('https://myblog.com')
        .setValue(this.plugin.settings.blogUrl)
        .onChange(async (value) => {
          this.plugin.settings.blogUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Writing Folder Path')
      .setDesc('The path to the root folder containing your drafts and published posts.')
      .addText(text => text
        .setPlaceholder('writing')
        .setValue(this.plugin.settings.writingFolderPath)
        .onChange(async (value) => {
          this.plugin.settings.writingFolderPath = value;
          await this.plugin.saveSettings();
        }));

    // New Setting for Ghost Admin API Key Secret Name
    new Setting(containerEl)
      .setName('Ghost Admin API Key Secret Name')
      .setDesc('The name of the secret stored in Obsidian\'s secure storage for your Ghost Admin API Key.')
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.ghostApiKeyName)
        .setValue(this.plugin.settings.ghostApiKeyName)
        .onChange(async (value) => {
          this.plugin.settings.ghostApiKeyName = value;
          await this.plugin.saveSettings();
        }));
  }
}
