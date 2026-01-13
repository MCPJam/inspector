import type { Widget } from './types.js';

/**
 * Widget Registry - Manages widget registration and retrieval
 */
export class WidgetRegistry {
  private widgets: Map<string, Widget> = new Map();

  /**
   * Register a widget
   */
  register(widget: Widget): void {
    if (this.widgets.has(widget.id)) {
      throw new Error(`Widget with id "${widget.id}" is already registered`);
    }
    this.widgets.set(widget.id, widget);
    console.log(`✓ Widget registered: ${widget.name} (${widget.id})`);
  }

  /**
   * Get a widget by ID
   */
  get(id: string): Widget | undefined {
    return this.widgets.get(id);
  }

  /**
   * Get all registered widgets
   */
  getAll(): Widget[] {
    return Array.from(this.widgets.values());
  }

  /**
   * Check if a widget exists
   */
  has(id: string): boolean {
    return this.widgets.has(id);
  }

  /**
   * Unregister a widget
   */
  unregister(id: string): void {
    const widget = this.widgets.get(id);
    if (widget) {
      this.widgets.delete(id);
      console.log(`✓ Widget unregistered: ${widget.name} (${id})`);
    }
  }

  /**
   * Get widget manifest for OpenAI App
   */
  getManifest(): {
    widgets: Widget[];
  } {
    return {
      widgets: this.getAll(),
    };
  }
}

