import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

interface LookupFormModel {
  readonly search: FormControl<string>;
}

@Component({
  selector: 'app-performer-lookup-section',
  imports: [ReactiveFormsModule],
  templateUrl: './performer-lookup-section.html',
  styleUrl: './performer-lookup-section.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PerformerLookupSectionComponent {
  readonly lookupForm = input.required<FormGroup<LookupFormModel>>();
  readonly addError = input<string | undefined>(undefined);
  readonly missingPerformerCount = input.required<number>();
  readonly missingLookupInProgress = input(false);
  readonly addPerformer = output<void>();
  readonly autoUpdateRequested = output<void>();

  onAddPerformer(): void {
    this.addPerformer.emit();
  }

  onMissingSearchRequested(): void {
    this.autoUpdateRequested.emit();
  }

  showMissingSearchPrompt = true;

  onMissingSearchCancelled(): void {
    this.showMissingSearchPrompt = false;
  }
}
