import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';

import { PerformerDetailsSectionComponent } from './components/performer-details-section/performer-details-section';
import { PerformerListSectionComponent } from './components/performer-list-section/performer-list-section';
import { PerformerLookupSectionComponent } from './components/performer-lookup-section/performer-lookup-section';
import { CatalogEntitySummary } from './models';
import { PerformerLookupService } from './services/performers/performer-lookup.service';

@Component({
  selector: 'app-root',
  imports: [
    PerformerLookupSectionComponent,
    PerformerListSectionComponent,
    PerformerDetailsSectionComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly performerLookup = inject(PerformerLookupService);

  readonly performers = this.performerLookup.performers;
  readonly selectedProfile = this.performerLookup.selectedProfile;
  readonly selectedPerformerId = this.performerLookup.selectedPerformerId;
  readonly addError = signal<string | undefined>(undefined);
  readonly selectedAge = computed(() => {
    const birthday = this.selectedProfile()?.birthday;

    return birthday ? calculateAge(birthday) : undefined;
  });

  readonly lookupForm = new FormGroup({
    search: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    this.lookupForm.controls.search.valueChanges.subscribe((value) => this.performerLookup.updateSearchTerm(value));
  }

  selectPerformer(summary: CatalogEntitySummary): void {
    this.performerLookup.selectPerformer(summary);
  }

  removePerformer(summary: CatalogEntitySummary): void {
    this.performerLookup.removePerformer(summary);
  }

  addPerformer(): void {
    const name = this.lookupForm.controls.search.value.trim();

    if (!name) {
      this.addError.set('Enter a performer name.');
      return;
    }

    this.performerLookup.addPerformer(name);
    this.lookupForm.reset({ search: '' });
    this.addError.set(undefined);
  }
  
  creditsOpen = signal(false);

  toggleCredits(): void {
    this.creditsOpen.update(open => !open);
  }
}

function calculateAge(birthday: string, today = new Date()): number | undefined {
  const birthDate = new Date(birthday);

  if (Number.isNaN(birthDate.getTime())) {
    return undefined;
  }

  let age = today.getFullYear() - birthDate.getFullYear();
  const hasHadBirthdayThisYear =
    today.getMonth() > birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() >= birthDate.getDate());

  if (!hasHadBirthdayThisYear) {
    age -= 1;
  }

  return age;
}
