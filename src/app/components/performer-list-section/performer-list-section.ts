import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { CatalogEntitySummary } from '../../models';
import { PerformerSearchResult } from '../../services/performers/performer-lookup.service';
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
  private readonly fetchPerformerInfo = 'fetch-performer-info';
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  private previousSelectedPerformerId: string | undefined;
  readonly performers = input.required<readonly PerformerSearchResult[]>();
  readonly selectedPerformerId = input<string | undefined>(undefined);
  readonly performerSelected = output<CatalogEntitySummary>();
  readonly performerRemoved = output<CatalogEntitySummary>();
  readonly performerFetchRequested = output<CatalogEntitySummary>();
  readonly contextMenu = signal<ContextMenuState | undefined>(undefined);
  readonly contextMenuActions: readonly ContextMenuAction[] = [
    { id: this.fetchPerformerInfo, label: 'Fetch performer info', destructive: false },
    { id: this.removeActionId, label: 'Remove performer', destructive: true },
  ];

  constructor() {
    effect(() => {
      const selectedPerformerId = this.selectedPerformerId();

      if (!selectedPerformerId) {
        this.previousSelectedPerformerId = undefined;
        return;
      }

      if (selectedPerformerId === this.previousSelectedPerformerId) {
        return;
      }

      this.previousSelectedPerformerId = selectedPerformerId;
      queueMicrotask(() => {
        const selectedButton = this.hostElement.nativeElement.querySelector(
          `[data-performer-id="${selectedPerformerId}"]`,
        ) as HTMLButtonElement | null;

        if (!selectedButton) {
          return;
        }

        selectedButton.scrollIntoView({ block: 'center' });
        selectedButton.focus();
      });
    });
  }

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

    if (!menu) {
      return;
    }

    if (actionId === this.removeActionId) {
      this.performerRemoved.emit(menu.performer);
      this.contextMenu.set(undefined);
      return;
    }

    if (actionId === this.fetchPerformerInfo) {
      this.performerFetchRequested.emit(menu.performer);
      this.contextMenu.set(undefined);
    }
  }
}

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly performer: CatalogEntitySummary;
}
