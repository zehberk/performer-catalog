import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { CatalogEntitySummary } from '../../models';

@Component({
  selector: 'app-performer-list-section',
  templateUrl: './performer-list-section.html',
  styleUrl: './performer-list-section.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PerformerListSectionComponent {
  readonly performers = input.required<readonly CatalogEntitySummary[]>();
  readonly selectedPerformerId = input<string | undefined>(undefined);
  readonly performerSelected = output<CatalogEntitySummary>();

  onSelectPerformer(performer: CatalogEntitySummary): void {
    this.performerSelected.emit(performer);
  }
}
