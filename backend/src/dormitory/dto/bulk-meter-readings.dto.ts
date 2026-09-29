import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsMongoId,
  IsArray,
  IsBoolean,
  ValidateNested,
  Min,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RoomMeterReadingItemDto {
  @IsNotEmpty()
  @IsMongoId()
  room_id: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  electricity_reading: number;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  water_reading: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  previous_electricity_reading?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  previous_water_reading?: number;

  @IsOptional()
  @IsBoolean()
  is_exempt?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class BulkMeterReadingsDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'billing_month phải có định dạng YYYY-MM (ví dụ: 2026-03)',
  })
  billing_month: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoomMeterReadingItemDto)
  readings: RoomMeterReadingItemDto[];
}
