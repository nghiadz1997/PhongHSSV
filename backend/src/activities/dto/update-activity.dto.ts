import { PartialType } from '@nestjs/swagger';
import { CreateActivityDto } from './create-activity.dto';
import { IsEnum, IsMongoId, IsOptional, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class UpdateActivityDto extends PartialType(CreateActivityDto) {
  /** Explicit null selects the authenticated administrator as responsible. */
  @ApiPropertyOptional({ description: 'Explicit null selects the authenticated administrator as responsible.' })
  @IsOptional()
  @Transform(({ value }) => (!value || value === '__DEFAULT_ADMIN__' ? null : value))
  @ValidateIf((o) => o.advisor_id !== null && o.advisor_id !== undefined && o.advisor_id !== '' && o.advisor_id !== '__DEFAULT_ADMIN__')
  @IsMongoId({ message: 'advisor_id must be a mongodb id' })
  advisor_id?: string | null;

  @ApiPropertyOptional({
    description: 'Activity status',
    enum: ['active', 'inactive', 'suspended'],
  })
  @IsOptional()
  @IsEnum(['active', 'inactive', 'suspended'])
  status?: string;
}
