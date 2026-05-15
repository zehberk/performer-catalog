import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';

import { CatalogEntitySummary, PerformerProfile } from '../../models';

const customPerformersStorageKey = 'performer-catalog.custom-performers';

@Injectable({
  providedIn: 'root',
})
export class PerformerLookupService {
  private readonly http = inject(HttpClient);
  private readonly generatedPerformers = signal<readonly CatalogEntitySummary[]>([]);
  private readonly customPerformers = signal<readonly CatalogEntitySummary[]>(this.readCustomPerformers());
  private readonly selectedProfileState = signal<PerformerProfile | undefined>(undefined);
  private readonly selectedId = signal<string | undefined>(undefined);

  readonly searchTerm = signal('');
  readonly selectedProfile = this.selectedProfileState.asReadonly();
  readonly performers = computed(() => {
    const searchTerm = this.searchTerm().trim().toLowerCase();
    const performers = [...this.generatedPerformers(), ...this.customPerformers()].sort((first, second) =>
      first.name.localeCompare(second.name),
    );

    if (!searchTerm) {
      return performers;
    }

    return performers.filter((performer) => performer.name.toLowerCase().includes(searchTerm));
  });

  readonly selectedPerformerId = this.selectedId.asReadonly();

  constructor() {
    this.http.get<readonly CatalogEntitySummary[]>('data/performers.index.json').subscribe({
      next: (performers) => this.generatedPerformers.set(performers),
      error: () => this.generatedPerformers.set([]),
    });
  }

  updateSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  addPerformer(name: string): void {
    const trimmedName = name.trim();

    if (!trimmedName) {
      return;
    }

    const existing = [...this.generatedPerformers(), ...this.customPerformers()].some(
      (performer) => performer.name.toLowerCase() === trimmedName.toLowerCase(),
    );

    if (existing) {
      return;
    }

    const performer: CatalogEntitySummary = {
      id: createEntityId(trimmedName),
      name: trimmedName,
      completed: false,
      type: 'performer',
      profilePath: '',
    };
    const customPerformers = [...this.customPerformers(), performer].sort((first, second) =>
      first.name.localeCompare(second.name),
    );

    this.customPerformers.set(customPerformers);
    localStorage.setItem(customPerformersStorageKey, JSON.stringify(customPerformers));
  }

  selectPerformer(summary: CatalogEntitySummary): void {
    this.selectedId.set(summary.id);

    if (!summary.profilePath) {
      this.selectedProfileState.set({
        id: summary.id,
        name: summary.name,
        completed: false,
        isPerformer: true,
      });
      return;
    }

    this.http.get<PerformerProfile>(summary.profilePath).subscribe({
      next: (profile) => this.selectedProfileState.set(profile),
      error: () =>
        this.selectedProfileState.set({
          id: summary.id,
          name: summary.name,
          completed: false,
          isPerformer: true,
        }),
    });
  }

  private readCustomPerformers(): readonly CatalogEntitySummary[] {
    try {
      const value = localStorage.getItem(customPerformersStorageKey);
      const performers = value ? (JSON.parse(value) as readonly CatalogEntitySummary[]) : [];

      return performers.filter((performer) => performer.type === 'performer');
    } catch {
      return [];
    }
  }
}

function createEntityId(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
