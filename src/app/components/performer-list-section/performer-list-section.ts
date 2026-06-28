import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
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
  private static readonly listScrollTopStorageKey = 'performer-catalog.list-scroll-top';
  private readonly removeActionId = 'remove-performer';
  private readonly fetchPerformerInfo = 'fetch-performer-info';
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private previousSelectedPerformerId: string | undefined;
  private previousSelectionRenderKey: string | undefined;
  private readonly onListScroll = (event: Event): void => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    sessionStorage.setItem(
      PerformerListSectionComponent.listScrollTopStorageKey,
      String(target.scrollTop),
    );
  };
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
    afterNextRender(() => {
      const list = this.hostElement.nativeElement.querySelector('.performer-scroll');

      if (!(list instanceof HTMLElement)) {
        return;
      }

      const storedScrollTop = Number.parseInt(
        sessionStorage.getItem(PerformerListSectionComponent.listScrollTopStorageKey) ?? '',
        10,
      );

      if (Number.isFinite(storedScrollTop) && storedScrollTop >= 0) {
        list.scrollTop = storedScrollTop;
      }

      list.addEventListener('scroll', this.onListScroll, { passive: true });
      this.destroyRef.onDestroy(() => list.removeEventListener('scroll', this.onListScroll));
    });

    effect(() => {
      const selectedPerformerId = this.selectedPerformerId();
      const performerIds = this.performers().map((performer) => performer.id);
      const selectionRenderKey = `${selectedPerformerId ?? ''}|${performerIds.join(',')}`;

      if (!selectedPerformerId) {
        this.previousSelectedPerformerId = undefined;
        this.previousSelectionRenderKey = undefined;
        return;
      }

      if (selectionRenderKey === this.previousSelectionRenderKey) {
        return;
      }

      const didSelectionChange = selectedPerformerId !== this.previousSelectedPerformerId;
      this.previousSelectedPerformerId = selectedPerformerId;
      this.previousSelectionRenderKey = selectionRenderKey;
      queueMicrotask(() => {
        const selectedButton = this.hostElement.nativeElement.querySelector(
          `[data-performer-id="${selectedPerformerId}"]`,
        ) as HTMLButtonElement | null;

        if (!selectedButton) {
          return;
        }

        const list = this.hostElement.nativeElement.querySelector('.performer-scroll');

        if (!(list instanceof HTMLElement)) {
          return;
        }

        const selectedBounds = selectedButton.getBoundingClientRect();
        const listBounds = list.getBoundingClientRect();
        const isVisible =
          selectedBounds.top >= listBounds.top && selectedBounds.bottom <= listBounds.bottom;

        if (didSelectionChange || !isVisible) {
          selectedButton.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
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
      this.performerSelected.emit(menu.performer);
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
