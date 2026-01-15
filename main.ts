import { App, Plugin, PluginSettingTab, Setting, Notice, requestUrl, RequestUrlParam, TFile } from 'obsidian';
import { sign } from 'jsonwebtoken';
import { FormDataEncoder } from 'form-data-encoder';

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

// Helper: slugify function
function slugify(text: string): string {
  return text
    .toString()
    .normalize('NFD') // split an accented letter in the base letter and the acent
    .replace(/[\u0300-\u036f]/g, '') // remove all previously split accents
    .toLowerCase()
    .trim() // Remove whitespace from both sides of a string
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w\-]+/g, '') // Remove all non-word chars
    .replace(/\-\-+/g, '-'); // Replace multiple - with single -
}

// Helper: JWT generation function
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

  private getMimeType(extension: string): string {
    const mimeTypes: { [key: string]: string } = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
    };
    return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
  }

  private parseFrontmatterString(fmString: string, field: string): string | null {
    const regex = new RegExp(`^${field}:\\s*(.*)`, 'm');
    const match = fmString.match(regex);
    return match ? match[1].replace(/^['"]|['"]$/g, '').trim() : null;
  }

  private async resolveInternalLinks(markdownContent: string, sourcePath: string): Promise<string> {
    const linkRegex = /(?<!\!)\[\[([^\]]+)\]\]/g;
    let processedMarkdown = markdownContent;
    const matches = Array.from(markdownContent.matchAll(linkRegex));

    if (matches.length > 0) {
      new Notice(`Found ${matches.length} internal link(s) to resolve...`);
    }

    for (const match of matches) {
      const linktext = match[1];
      const [linkPath, anchor] = linktext.split('#');
      const linkTargetFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);

      if (!linkTargetFile) {
        throw new Error(`Could not resolve internal link: [[${linktext}]]`);
      }

      const targetContent = await this.app.vault.read(linkTargetFile);
      const targetParts = targetContent.split('---', 3);

      if (targetParts.length < 3) {
        throw new Error(`Cannot publish: Linked post '${linkPath}' is not published (missing frontmatter).`);
      }

      const targetFrontmatter = targetParts[1];
      const publishedUrl = this.parseFrontmatterString(targetFrontmatter, 'publishedUrl');

      if (!publishedUrl) {
        throw new Error(`Cannot publish: Linked post '${linkPath}' is not published (missing 'publishedUrl').`);
      }

      let finalUrl = publishedUrl;
      if (anchor) {
        finalUrl += `#${slugify(anchor)}`;
      }

      processedMarkdown = processedMarkdown.replace(match[0], `[${linktext}](${finalUrl})`);
    }

    return processedMarkdown;
  }

  private async uploadAndReplaceImages(markdownContent: string, token: string, sourcePath: string): Promise<string> {
    const imageRegex = /!\[(?:\[([^\]]*)\])?\(([^)]+)\)|!\[\[([^\]]+)\]\]/g;
    let processedMarkdown = markdownContent;
    const matches = Array.from(markdownContent.matchAll(imageRegex));

    if (matches.length > 0) {
      new Notice(`Found ${matches.length} image(s) to upload...`);
    }

    for (const match of matches) {
      const isWikiLink = match[3] !== undefined;
      const localSrc = isWikiLink ? match[3] : match[2];
      const altText = isWikiLink ? '' : match[1] || '';

      const imageFile = this.app.metadataCache.getFirstLinkpathDest(localSrc, sourcePath);
      if (!imageFile) {
        throw new Error(`Image not found in vault: ${localSrc}`);
      }

      const imageData = await this.app.vault.readBinary(imageFile);
      const mimeType = this.getMimeType(imageFile.extension);
      
      const formData = new FormData();
      formData.append('file', new Blob([imageData], { type: mimeType }), imageFile.name);
      formData.append('ref', imageFile.path);
      formData.append('purpose', 'image');

      const encoder = new FormDataEncoder(formData);
      
      const chunks: Uint8Array[] = [];
      for await (const chunk of encoder) {
        chunks.push(chunk);
      }
      const bodyBuffer = Buffer.concat(chunks);
      
      const normalizedUrl = this.settings.blogUrl.replace(/\/$/, '');
      const uploadUrl = `${normalizedUrl}/ghost/api/admin/images/upload/`;

      const requestParams: RequestUrlParam = {
        url: uploadUrl,
        method: 'POST',
        headers: {
          'Authorization': `Ghost ${token}`,
          'Content-Type': encoder.headers['Content-Type'],
        },
        body: bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength),
        throw: false
      };

      const response = await requestUrl(requestParams);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Image upload failed for ${localSrc}: Status ${response.status} - ${response.text}`);
      }
      
      const uploadedImageData = response.json;
      const remoteUrl = uploadedImageData.images[0].url;

      processedMarkdown = processedMarkdown.replace(match[0], `![${altText}](${remoteUrl})`);
    }
    return processedMarkdown;
  }

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
        // --- 1. Get active file and extract content ---
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active file to publish.');
          return;
        }
        if (activeFile.extension !== 'md') {
          new Notice('Can only publish Markdown files.');
          return;
        }

        try {
          const fileContent = await this.app.vault.read(activeFile);
          const parts = fileContent.split('---', 3);

          let frontmatter = '';
          let markdownContent = fileContent;
          let title = activeFile.basename;

          if (parts.length >= 3) {
            frontmatter = parts[1];
            markdownContent = parts.slice(2).join('---').trim();
            title = this.parseFrontmatterString(frontmatter, 'title') || activeFile.basename;
          } else {
            markdownContent = fileContent.trim();
          }

          // --- 2. Get Settings and API Key ---
          const { blogUrl, ghostApiKeyName } = this.settings;
          if (!blogUrl || !ghostApiKeyName) {
            new Notice('Blog URL and API Key Name must be set in settings.');
            return;
          }

          const apiKey = await this.app.secretStorage.getSecret(ghostApiKeyName);
          if (!apiKey) {
            new Notice(`API Key secret named '${ghostApiKeyName}' not found.`);
            return;
          }

          // --- 3. Generate JWT ---
          const token = generateGhostAdminToken(apiKey);
          if (!token) {
            new Notice('API Key is not in the correct format (id:secret).');
            return;
          }
          
          // --- 4. Process Content (Compiler) ---
          const markdownWithImages = await this.uploadAndReplaceImages(markdownContent, token, activeFile.path);
          const finalMarkdown = await this.resolveInternalLinks(markdownWithImages, activeFile.path);

          // --- 5. Generate Slug ---
          const slug = slugify(title);
          
          // --- 6. Construct Mobiledoc Payload ---
          const mobiledocPayload = {
            version: '0.3.1',
            atoms: [],
            cards: [
              ['markdown', { cardName: 'markdown', markdown: finalMarkdown }]
            ],
            markups: [],
            sections: [[10, 0]]
          };

          const postPayload = {
            posts: [{
              title: title,
              slug: slug,
              status: 'published',
              mobiledoc: JSON.stringify(mobiledocPayload)
            }]
          };

          // --- 7. Make API Request (POST) ---
          const normalizedUrl = blogUrl.replace(/\/$/, '');
          const apiUrl = `${normalizedUrl}/ghost/api/admin/posts/`;

          new Notice(`Attempting to publish "${title}"...`);
          console.log('Sending post payload:', postPayload);

          const postRequestParams: RequestUrlParam = {
            url: apiUrl,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Ghost ${token}`
            },
            body: JSON.stringify(postPayload),
            throw: false
          };

          const response = await requestUrl(postRequestParams);

          if (response.status < 200 || response.status >= 300) {
            throw new Error(`Post creation failed: Status ${response.status} - ${response.text}`);
          }
          
          const responseData = response.json;
          const newPost = responseData.posts[0];

          new Notice(`Published "${newPost.title}"! ID: ${newPost.id}, URL: ${newPost.url}`, 15000);
          console.log('Successfully published post:', newPost);

          // --- 8. Update Frontmatter in Obsidian ---
          const currentDate = new Date().toISOString().split('T')[0];
          let updatedFrontmatter = frontmatter;

          const updateFrontmatterField = (fmString: string, field: string, value: string): string => {
            const regex = new RegExp(`^${field}:.*`, 'm');
            const newValueLine = `${field}: ${value}`;
            
            const trimmedFm = fmString.trim();
            if (trimmedFm === '') {
              return newValueLine + '\n';
            }

            if (fmString.match(regex)) {
              return fmString.replace(regex, newValueLine);
            } else {
              if (fmString.endsWith('\n')) {
                  return fmString + newValueLine + '\n';
              } else {
                  return fmString + '\n' + newValueLine + '\n';
              }
            }
          };
          
          updatedFrontmatter = updateFrontmatterField(updatedFrontmatter, 'ghostPostId', newPost.id);
          updatedFrontmatter = updateFrontmatterField(updatedFrontmatter, 'publishedUrl', newPost.url);
          updatedFrontmatter = updateFrontmatterField(updatedFrontmatter, 'publishedDate', currentDate);
          
          let updatedFileContent = `---\n${updatedFrontmatter}---\n${markdownContent}`;
          if (parts.length < 3) {
            updatedFileContent = `---\ntitle: ${title}\nghostPostId: ${newPost.id}\npublishedUrl: ${newPost.url}\npublishedDate: ${currentDate}\n---\n${fileContent}`;
          }

          await this.app.vault.modify(activeFile, updatedFileContent);
          new Notice('Frontmatter updated.', 4000);
          console.log('Frontmatter updated.');

          // --- 9. Move File to Published Folder ---
          const writingFolderPath = this.settings.writingFolderPath;
          const publishedFolderPath = `${writingFolderPath}/Published`;
          
          try {
            await this.app.vault.createFolder(publishedFolderPath);
          } catch (e) {
            // Folder already exists, which is fine.
          }
          
          const newFilePath = `${publishedFolderPath}/${activeFile.name}`;
          await this.app.vault.rename(activeFile, newFilePath);
          new Notice(`File moved to "${publishedFolderPath}"`, 5000);
          console.log(`File moved to ${newFilePath}`);


        } catch (error) {
          console.error('--- DETAILED PUBLISH ERROR ---');
          console.error('Error Object:', error);
          
          let detailedMessage = 'An unknown error occurred.';
          
          if (error && typeof error === 'object') {
            try {
              console.error('Error stringified:', JSON.stringify(error, null, 2));
              detailedMessage = (error as any).message || JSON.stringify(error);
            } catch (e) {
              console.error('Could not stringify the error object:', e);
              detailedMessage = 'An un-stringifiable error object was thrown. Check the "Error Object" log above.';
            }
          } else {
            detailedMessage = String(error);
          }
          
          console.error('--- END DETAILED ERROR ---');
          new Notice(`Error: ${detailedMessage.substring(0, 150)}. Check developer console for full details.`, 15000);
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
