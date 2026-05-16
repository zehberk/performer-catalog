import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

interface FetchFormModel {
  readonly iafdUrl: FormControl<string>;
}

@Component({
  selector: 'app-performer-fetch-dialog',
  imports: [ReactiveFormsModule],
  templateUrl: './performer-fetch-dialog.html',
  styleUrl: './performer-fetch-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PerformerFetchDialogComponent {
  readonly performerName = input.required<string>();
  readonly loading = input(false);
  readonly errorMessage = input<string | undefined>(undefined);
  readonly fetchRequested = output<string>();
  readonly searchWithoutLinkRequested = output<void>();
  readonly cancelRequested = output<void>();

  readonly form = new FormGroup<FetchFormModel>({
    iafdUrl: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  onFetch(): void {
    if (this.loading()) {
      return;
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.fetchRequested.emit(this.form.controls.iafdUrl.value.trim());
  }

  onSearchWithoutLink(): void {
    this.searchWithoutLinkRequested.emit();
  }

  onCancel(): void {
    this.cancelRequested.emit();
  }
}
