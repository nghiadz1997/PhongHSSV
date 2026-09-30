import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsMongoId,
  IsDate,
  ValidateNested,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';

export class ActivitySettingsDto {
  @ApiPropertyOptional({ description: 'Require an active registration before attendance', default: true })
  @IsOptional()
  @IsBoolean()
  require_registration_for_attendance?: boolean;

  @ApiPropertyOptional({
    description: 'Allow students to self-register',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  allow_self_registration?: boolean;

  @ApiPropertyOptional({
    description: 'Require approval for registration',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  require_approval?: boolean;

  @ApiPropertyOptional({
    description: 'Enable training points from attendance',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  attendance_point_enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Points awarded per attendance',
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  point_per_attendance?: number;

  @ApiPropertyOptional({
    description: 'Criterion ID for training point mapping',
  })
  @IsOptional()
  @IsMongoId()
  criterion_id?: string;
}

export class CardUiDto {
  @ApiPropertyOptional({
    description: 'Theme for the activity card',
    enum: ['default', 'academic', 'sports', 'art', 'volunteer', 'technology', 'other'],
    default: 'default',
  })
  @IsOptional()
  @IsEnum(['default', 'academic', 'sports', 'art', 'volunteer', 'technology', 'other'])
  theme?: string;

  @ApiPropertyOptional({
    description: 'Accent color for the activity card',
  })
  @IsOptional()
  @IsString()
  accent_color?: string;

  @ApiPropertyOptional({
    description: 'Display style for the activity card',
    enum: ['classic', 'spotlight', 'minimal'],
    default: 'classic',
  })
  @IsOptional()
  @IsEnum(['classic', 'spotlight', 'minimal'])
  style?: string;
}

export class StateButtonConfigDto {
  @ApiPropertyOptional({ description: 'Button label' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({ description: 'Button background class (Tailwind)' })
  @IsOptional()
  @IsString()
  bgClass?: string;

  @ApiPropertyOptional({ description: 'Button text class (Tailwind)' })
  @IsOptional()
  @IsString()
  textClass?: string;
}

export class BackgroundStatesConfigDto {
  @ApiPropertyOptional({ description: 'Default state button configuration' })
  @IsOptional()
  @ValidateNested()
  @Type(() => StateButtonConfigDto)
  none?: StateButtonConfigDto;

  @ApiPropertyOptional({ description: 'Pending state button configuration' })
  @IsOptional()
  @ValidateNested()
  @Type(() => StateButtonConfigDto)
  pending?: StateButtonConfigDto;

  @ApiPropertyOptional({ description: 'Active state button configuration' })
  @IsOptional()
  @ValidateNested()
  @Type(() => StateButtonConfigDto)
  active?: StateButtonConfigDto;

  @ApiPropertyOptional({ description: 'Rejected state button configuration' })
  @IsOptional()
  @ValidateNested()
  @Type(() => StateButtonConfigDto)
  rejected?: StateButtonConfigDto;
}

export class BackgroundConfigDto {
  @ApiPropertyOptional({ description: 'Preset background style' })
  @IsOptional()
  @IsString()
  preset?: string;

  @ApiPropertyOptional({ description: 'Accent color' })
  @IsOptional()
  @IsString()
  accentColor?: string;

  @ApiPropertyOptional({ description: 'Background image URL' })
  @IsOptional()
  @IsString()
  backgroundImageUrl?: string;

  @ApiPropertyOptional({ description: 'Use avatar image as card background' })
  @IsOptional()
  @IsBoolean()
  useAvatarAsBackground?: boolean;

  @ApiPropertyOptional({ description: 'URL of the background frame image' })
  @IsOptional()
  @IsString()
  backgroundFrameUrl?: string;

  @ApiPropertyOptional({ description: 'Subtle decorative pattern style' })
  @IsOptional()
  @IsString()
  pattern?: string;

  @ApiPropertyOptional({ description: 'Pet accent motion type' })
  @IsOptional()
  @IsString()
  petAccentType?: string;

  @ApiPropertyOptional({ description: 'State buttons styling configurations' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackgroundStatesConfigDto)
  states?: BackgroundStatesConfigDto;
}

export class CreateActivityDto {
  @ApiProperty({ description: 'Activity name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Unique activity code (auto uppercase)' })
  @IsString()
  code: string;

  @ApiPropertyOptional({
    description: 'Activity type',
    enum: ['club', 'event', 'activity', 'festival'],
    default: 'activity',
  })
  @IsOptional()
  @IsEnum(['club', 'event', 'activity', 'festival'])
  activity_type?: string;

  @ApiPropertyOptional({
    description: 'Participation lifecycle status',
    enum: ['draft', 'published', 'completed', 'cancelled'],
    default: 'published',
  })
  @IsOptional()
  @IsEnum(['draft', 'published', 'completed', 'cancelled'])
  participation_status?: string;

  @ApiProperty({ description: 'Default classroom or activity room' })
  @IsString()
  @IsNotEmpty()
  classroom: string;

  @ApiPropertyOptional({ description: 'Activity description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Activity category',
    enum: ['academic', 'sports', 'art', 'volunteer', 'technology', 'other'],
  })
  @IsEnum(['academic', 'sports', 'art', 'volunteer', 'technology', 'other'])
  category: string;

  @ApiPropertyOptional({ description: 'Logo URL' })
  @IsOptional()
  @IsString()
  logo_url?: string;

  @ApiPropertyOptional({ description: 'Cover image URL' })
  @IsOptional()
  @IsString()
  cover_url?: string;

  @ApiPropertyOptional({ description: 'Advisor (teacher) user ID; defaults to the creating administrator when omitted' })
  @IsOptional()
  @Transform(({ value }) => (!value || value === '__DEFAULT_ADMIN__' ? undefined : value))
  @ValidateIf((o) => o.advisor_id !== null && o.advisor_id !== undefined && o.advisor_id !== '' && o.advisor_id !== '__DEFAULT_ADMIN__')
  @IsMongoId({ message: 'advisor_id must be a mongodb id' })
  advisor_id?: string | null;

  @ApiPropertyOptional({ description: 'President (student) ID' })
  @IsOptional()
  @IsMongoId()
  president_id?: string;

  @ApiPropertyOptional({ description: 'Vice president student IDs' })
  @IsOptional()
  @IsMongoId({ each: true })
  vice_president_ids?: string[];

  @ApiPropertyOptional({ description: 'Maximum number of members' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  max_members?: number;

  @ApiPropertyOptional({ description: 'Founded date' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  founded_date?: Date;

  @ApiPropertyOptional({ description: 'Activity start date' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  activity_start_date?: Date;

  @ApiPropertyOptional({ description: 'Activity end date' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  activity_end_date?: Date;

  @ApiPropertyOptional({ description: 'Semester ID' })
  @IsOptional()
  @IsMongoId()
  semester_id?: string;

  @ApiPropertyOptional({ description: 'Activity settings' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ActivitySettingsDto)
  settings?: ActivitySettingsDto;

  @ApiPropertyOptional({ description: 'Activity card UI customization' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CardUiDto)
  card_ui?: CardUiDto;

  @ApiPropertyOptional({ description: 'Activity background UI configuration' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackgroundConfigDto)
  background_config?: BackgroundConfigDto;
}
