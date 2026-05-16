import { ChangeDetectionStrategy, Component, signal, input, output } from '@angular/core';

import { CatalogEntitySummary } from '../../models';
import {
  ContextMenuAction,
  PerformerContextMenuComponent,
} from '../performer-context-menu/performer-context-menu';

@Component({
  selector: 'app-performer-list-section',
  imports: [PerformerContextMenuComponent],
  templateUrl: './performer-list-section.html',
  styleUrl: './performer-list-section.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PerformerListSectionComponent {
  private readonly removeActionId = 'remove-performer';
  readonly performers = input.required<readonly CatalogEntitySummary[]>();
  readonly selectedPerformerId = input<string | undefined>(undefined);
  readonly performerSelected = output<CatalogEntitySummary>();
  readonly performerRemoved = output<CatalogEntitySummary>();
  readonly contextMenu = signal<ContextMenuState | undefined>(undefined);
  readonly contextMenuActions: readonly ContextMenuAction[] = [
    { id: this.removeActionId, label: 'Remove performer', destructive: true },
  ];

  onSelectPerformer(performer: CatalogEntitySummary): void {
    this.performerSelected.emit(performer);
  }

  onOpenContextMenu(event: MouseEvent, performer: CatalogEntitySummary): void {
    event.preventDefault();
    this.contextMenu.set({ x: event.clientX, y: event.clientY, performer });
  }

  onCloseContextMenu(): void {
    this.contextMenu.set(undefined);
  }

  onMenuActionSelected(actionId: string): void {
    const menu = this.contextMenu();

    if (!menu || actionId !== this.removeActionId) {
      return;
    }

    this.performerRemoved.emit(menu.performer);
    this.contextMenu.set(undefined);
  }
}

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly performer: CatalogEntitySummary;
}
