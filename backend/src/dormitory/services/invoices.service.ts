import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Invoice, InvoiceDocument } from '../schemas/invoice.schema';
import { Contract, ContractDocument } from '../schemas/contract.schema';
import { Room, RoomDocument } from '../schemas/room.schema';
import {
  DormitoryRosterEntry,
  DormitoryRosterEntryDocument,
} from '../schemas/dormitory-roster-entry.schema';
import {
  UtilityConfig,
  UtilityConfigDocument,
} from '../schemas/utility-config.schema';
import {
  RoomFeeConfig,
  RoomFeeConfigDocument,
} from '../schemas/room-fee-config.schema';
import {
  CreateInvoiceDto,
  PayInvoiceDto,
  UpdatePaymentProofDto,
  BulkCreateInvoiceDto,
  CreateMonthlyInvoiceDto,
  UpdateMonthlyInvoiceDto,
  UtilityInputDto,
} from '../dto/create-invoice.dto';
import { UpdateUtilityConfigDto } from '../dto/utility-config.dto';
import { BulkMeterReadingsDto } from '../dto/bulk-meter-readings.dto';
import { randomUUID } from 'crypto';
import { MeterReading, MeterReadingDocument } from '../schemas/meter-reading.schema';
import { dormitoryInvoiceEventEmitter } from '../dormitory-invoice-event-emitter';
import { StorageService } from '../../core/storage/storage.service';


@Injectable()
export class InvoicesService {
  constructor(
    @InjectModel(Invoice.name) private invoiceModel: Model<InvoiceDocument>,
    @InjectModel(Contract.name)
    private contractModel: Model<ContractDocument>,
    @InjectModel(Room.name) private roomModel: Model<RoomDocument>,
    @InjectModel(DormitoryRosterEntry.name)
    private rosterModel: Model<DormitoryRosterEntryDocument>,
    @InjectModel(UtilityConfig.name)
    private utilityConfigModel: Model<UtilityConfigDocument>,
    @Optional()
    @InjectModel(RoomFeeConfig.name)
    private roomFeeConfigModel?: Model<RoomFeeConfigDocument>,
    @Optional() @InjectModel(MeterReading.name)
    private meterReadingModel?: Model<MeterReadingDocument>,
    @Optional() private readonly storageService?: StorageService,
  ) {}

  /**
   * Tính toán thông số điện / nước ở server
   */
  calculateUtility(
    occupantCount: number,
    input: UtilityInputDto,
    isExempt = false,
  ) {
    const prev = Number(input.previous_reading);
    const curr = Number(input.current_reading);
    const quotaPerPerson = Number(input.quota_per_person);
    const unitPrice = Number(input.unit_price);

    if (
      isNaN(prev) ||
      isNaN(curr) ||
      isNaN(quotaPerPerson) ||
      isNaN(unitPrice)
    ) {
      throw new BadRequestException('Thông số điện/nước phải là số hợp lệ');
    }

    if (prev < 0 || curr < 0 || quotaPerPerson < 0 || unitPrice < 0) {
      throw new BadRequestException('Thông số điện/nước không được là số âm');
    }

    if (curr < prev) {
      throw new BadRequestException(
        'Chỉ số mới không được nhỏ hơn chỉ số cũ',
      );
    }

    const consumption = curr - prev;
    const quota_total = (occupantCount || 0) * quotaPerPerson;
    const excess_consumption = Math.max(consumption - quota_total, 0);
    const amount = isExempt ? 0 : excess_consumption * unitPrice;

    return {
      previous_reading: prev,
      current_reading: curr,
      consumption,
      quota_per_person: quotaPerPerson,
      quota_total,
      excess_consumption,
      unit_price: unitPrice,
      amount,
    };
  }

  /**
   * Tạo hóa đơn điện - nước hàng tháng cho phòng
   */
  async createMonthly(
    dto: CreateMonthlyInvoiceDto,
    user: any,
  ): Promise<Invoice> {
    if (!Types.ObjectId.isValid(dto.room_id)) {
      throw new BadRequestException('Mã phòng không hợp lệ');
    }

    const room = await this.roomModel.findById(dto.room_id).exec();
    if (!room) {
      throw new NotFoundException('Không tìm thấy phòng');
    }

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(dto.billing_month)) {
      throw new BadRequestException(
        'Kỳ thu phải có định dạng YYYY-MM (ví dụ: 2026-03)',
      );
    }

    const readingDate = new Date(dto.reading_date);
    if (isNaN(readingDate.getTime())) {
      throw new BadRequestException('Ngày chốt chỉ số không hợp lệ');
    }

    const dueDate = new Date(dto.due_date);
    if (isNaN(dueDate.getTime())) {
      throw new BadRequestException('Hạn kết thúc thu không hợp lệ');
    }

    let paymentStartDate: Date | undefined;
    if (dto.payment_start_date) {
      paymentStartDate = new Date(dto.payment_start_date);
      if (isNaN(paymentStartDate.getTime())) {
        throw new BadRequestException('Thời gian bắt đầu thu không hợp lệ');
      }
      if (dueDate < paymentStartDate) {
        throw new BadRequestException(
          'Hạn kết thúc thu phải sau hoặc bằng ngày bắt đầu thu',
        );
      }
    }

    // Kiểm tra trùng kỳ thu theo phòng
    const existing = await this.invoiceModel
      .findOne({
        room_id: dto.room_id,
        billing_month: dto.billing_month,
      })
      .exec();
    if (existing) {
      throw new ConflictException(
        `Hóa đơn cho phòng này trong kỳ ${dto.billing_month} đã tồn tại`,
      );
    }

    // Lấy snapshot danh sách người ở từ DormitoryRosterEntry
    const rosterEntries = await this.rosterModel
      .find({
        room_id: dto.room_id,
      })
      .exec();
    const rosterEntryIds = rosterEntries.map((r) => r._id);
    const occupantCount =
      dto.occupant_count !== undefined
        ? Number(dto.occupant_count)
        : rosterEntries.length;

    if (occupantCount < 0 || isNaN(occupantCount)) {
      throw new BadRequestException('Số người ở không hợp lệ');
    }

    const isExempt = Boolean(dto.is_exempt);
    const electricity = this.calculateUtility(
      occupantCount,
      dto.electricity,
      isExempt,
    );
    const water = this.calculateUtility(
      occupantCount,
      dto.water,
      isExempt,
    );
    const total_amount = isExempt ? 0 : electricity.amount + water.amount;

    const invoice = new this.invoiceModel({
      invoice_code: `INV-${randomUUID().substring(0, 8).toUpperCase()}`,
      room_id: dto.room_id,
      billing_month: dto.billing_month,
      reading_date: readingDate,
      occupant_count: occupantCount,
      roster_entry_ids: rosterEntryIds,
      electricity,
      water,
      is_exempt: isExempt,
      payment_start_date: paymentStartDate,
      due_date: dueDate,
      total_amount,
      status: 'Chưa thu',
      notes: dto.notes,
    });

    const saved = await invoice.save();
    if (this.meterReadingModel) {
      await this.meterReadingModel.findOneAndUpdate(
        { room_id: dto.room_id, billing_month: dto.billing_month },
        {
          $set: {
            electricity_reading: dto.electricity?.current_reading ?? 0,
            water_reading: dto.water?.current_reading ?? 0,
            reading_date: readingDate,
            occupant_count: occupantCount,
            roster_entry_ids: rosterEntryIds,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).exec();
    }
    dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
      kind: 'utility',
      action: 'created',
      id: saved?._id ? saved._id.toString() : undefined,
    });
    return saved;
  }

  /**
   * Cập nhật thông số hóa đơn điện - nước trong modal Nâng cao
   */
  async updateMonthly(
    id: string,
    dto: UpdateMonthlyInvoiceDto,
    user: any,
  ): Promise<Invoice> {
    const invoice = await this.invoiceModel.findById(id).exec();
    if (!invoice) {
      throw new NotFoundException(`Không tìm thấy hóa đơn: ${id}`);
    }

    if (invoice.status === 'Đã thu' || invoice.status === 'Đã thanh toán') {
      throw new BadRequestException('Không thể chỉnh sửa hóa đơn đã thu');
    }

    let readingDate = invoice.reading_date;
    if (dto.reading_date) {
      readingDate = new Date(dto.reading_date);
      if (isNaN(readingDate.getTime())) {
        throw new BadRequestException('Ngày chốt chỉ số không hợp lệ');
      }
    }

    let paymentStartDate = invoice.payment_start_date;
    if (dto.payment_start_date !== undefined) {
      if (dto.payment_start_date) {
        paymentStartDate = new Date(dto.payment_start_date);
        if (isNaN(paymentStartDate.getTime())) {
          throw new BadRequestException(
            'Thời gian bắt đầu thu không hợp lệ',
          );
        }
      } else {
        paymentStartDate = undefined;
      }
    }

    let dueDate = invoice.due_date;
    if (dto.due_date) {
      dueDate = new Date(dto.due_date);
      if (isNaN(dueDate.getTime())) {
        throw new BadRequestException('Hạn kết thúc thu không hợp lệ');
      }
    }

    if (paymentStartDate && dueDate && dueDate < paymentStartDate) {
      throw new BadRequestException(
        'Hạn kết thúc thu phải sau hoặc bằng ngày bắt đầu thu',
      );
    }

    const occupantCount =
      dto.occupant_count !== undefined
        ? Number(dto.occupant_count)
        : invoice.occupant_count || 0;

    if (occupantCount < 0 || isNaN(occupantCount)) {
      throw new BadRequestException('Số người ở không hợp lệ');
    }

    const isExempt =
      dto.is_exempt !== undefined
        ? Boolean(dto.is_exempt)
        : Boolean(invoice.is_exempt);

    const electricityInput: UtilityInputDto = dto.electricity || {
      previous_reading: invoice.electricity?.previous_reading || 0,
      current_reading: invoice.electricity?.current_reading || 0,
      quota_per_person: invoice.electricity?.quota_per_person || 0,
      unit_price: invoice.electricity?.unit_price || 0,
    };

    const waterInput: UtilityInputDto = dto.water || {
      previous_reading: invoice.water?.previous_reading || 0,
      current_reading: invoice.water?.current_reading || 0,
      quota_per_person: invoice.water?.quota_per_person || 0,
      unit_price: invoice.water?.unit_price || 0,
    };

    const electricity = this.calculateUtility(
      occupantCount,
      electricityInput,
      isExempt,
    );
    const water = this.calculateUtility(
      occupantCount,
      waterInput,
      isExempt,
    );
    const total_amount = isExempt ? 0 : electricity.amount + water.amount;

    invoice.reading_date = readingDate;
    invoice.payment_start_date = paymentStartDate;
    invoice.due_date = dueDate;
    invoice.occupant_count = occupantCount;
    invoice.is_exempt = isExempt;
    invoice.electricity = electricity;
    invoice.water = water;
    invoice.total_amount = total_amount;
    if (dto.notes !== undefined) {
      invoice.notes = dto.notes;
    }

    const saved = await invoice.save();
    if (this.meterReadingModel && invoice.room_id && invoice.billing_month) {
      await this.meterReadingModel.findOneAndUpdate(
        { room_id: invoice.room_id, billing_month: invoice.billing_month },
        {
          $set: {
            electricity_reading: electricity.current_reading ?? 0,
            water_reading: water.current_reading ?? 0,
            reading_date: readingDate,
            occupant_count: occupantCount,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).exec();
    }
    dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
      kind: 'utility',
      action: 'updated',
      id: saved?._id ? saved._id.toString() : (id ? id.toString() : undefined),
    });
    return saved;
  }

  /**
   * Lấy thông tin phòng, số người ở từ Danh sách KTX và chỉ số tháng trước
   */
  async getRoomInfo(roomId: string, billingMonth?: string) {
    if (!Types.ObjectId.isValid(roomId)) {
      throw new BadRequestException('Mã phòng không hợp lệ');
    }

    const room = await this.roomModel
      .findById(roomId)
      .populate('building_id', 'building_code name')
      .exec();

    if (!room) {
      throw new NotFoundException('Không tìm thấy phòng');
    }

    const rosterEntries = await this.rosterModel
      .find({ room_id: roomId })
      .populate('student_id', 'student_code full_name')
      .exec();

    // Tìm hóa đơn gần nhất trước kỳ này (hoặc hóa đơn gần nhất nếu không truyền kỳ)
    const invoiceFilter: any = { room_id: roomId };
    if (billingMonth) {
      invoiceFilter.billing_month = { $lt: billingMonth };
    }
    const lastInvoice = await this.invoiceModel
      .findOne(invoiceFilter)
      .sort({ billing_month: -1, reading_date: -1, createdAt: -1 })
      .exec();

    let lastElec = lastInvoice?.electricity?.current_reading || 0;
    let lastWater = lastInvoice?.water?.current_reading || 0;

    if (this.meterReadingModel) {
      const readingFilter: any = { room_id: roomId };
      if (billingMonth) {
        readingFilter.billing_month = { $lt: billingMonth };
      }
      const lastReading = await this.meterReadingModel
        .findOne(readingFilter)
        .sort({ billing_month: -1, reading_date: -1 })
        .exec();
      if (lastReading) {
        if (lastReading.electricity_reading !== undefined && lastReading.electricity_reading !== null) {
          lastElec = lastReading.electricity_reading;
        }
        if (lastReading.water_reading !== undefined && lastReading.water_reading !== null) {
          lastWater = lastReading.water_reading;
        }
      }
    }

    const config = await this.getUtilityConfig();
    const effectiveTariffs = this.resolveEffectiveTariff(config, roomId);

    return {
      room,
      occupant_count: rosterEntries.length,
      occupants: rosterEntries.map((r) => ({
        _id: r._id,
        student_id: r.student_id,
        full_name: r.full_name,
        student_code: r.student_code,
      })),
      last_readings: {
        electricity: lastElec,
        water: lastWater,
      },
      effective_tariffs: effectiveTariffs,
    };
  }

  async create(dto: CreateInvoiceDto, user: any): Promise<Invoice> {
    const total_amount = dto.items.reduce((sum, item) => sum + item.amount, 0);

    const invoice = new this.invoiceModel({
      ...dto,
      invoice_code: `INV-${randomUUID().substring(0, 8).toUpperCase()}`,
      total_amount,
      status: 'Chưa thu',
    });

    const saved = await invoice.save();
    dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
      kind: 'utility',
      action: 'created',
      id: saved?._id ? saved._id.toString() : undefined,
    });
    return saved;
  }

  /**
   * UC07: Bulk generate invoices for all active contracts (legacy)
   */
  async bulkCreate(
    dto: BulkCreateInvoiceDto,
    user: any,
  ): Promise<{ created: number; skipped: number }> {
    const activeContracts = await this.contractModel
      .find({ status: 'Hiệu lực' })
      .populate('room_id', 'room_price')
      .exec();

    let created = 0;
    let skipped = 0;

    for (const contract of activeContracts) {
      const existing = await this.invoiceModel.findOne({
        contract_id: contract._id,
        billing_period: dto.billing_period,
      });
      if (existing) {
        skipped++;
        continue;
      }

      const room = contract.room_id as any;
      const giaPhong = room?.room_price || 0;

      const invoice = new this.invoiceModel({
        invoice_code: `INV-${randomUUID().substring(0, 8).toUpperCase()}`,
        contract_id: contract._id,
        student_id: contract.student_id,
        billing_period: dto.billing_period,
        items: [
          {
            type: 'Phí phòng',
            description: `Phí phòng kỳ ${dto.billing_period}`,
            amount: giaPhong,
          },
        ],
        total_amount: giaPhong,
        status: 'Chưa thu',
        due_date: new Date(dto.due_date),
      });

      await invoice.save();
      created++;
    }

    if (created > 0) {
      dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
        kind: 'utility',
        action: 'created',
      });
    }

    return { created, skipped };
  }

  async findAll(query: {
    room_id?: string;
    billing_month?: string;
    student_id?: string;
    contract_id?: string;
    status?: string;
    billing_period?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const filter: any = {};
    if (query.room_id) filter.room_id = query.room_id;
    if (query.billing_month) filter.billing_month = query.billing_month;
    if (query.student_id) filter.student_id = query.student_id;
    if (query.contract_id) filter.contract_id = query.contract_id;
    if (query.billing_period) filter.billing_period = query.billing_period;

    if (query.status) {
      if (query.status === 'Chưa thu') {
        filter.status = { $in: ['Chưa thu', 'Chưa thanh toán', 'Quá hạn'] };
      } else if (query.status === 'Đã thu') {
        filter.status = { $in: ['Đã thu', 'Đã thanh toán'] };
      } else {
        filter.status = query.status;
      }
    }

    if (query.search) {
      const searchRegex = { $regex: query.search, $options: 'i' };
      // Tìm phòng theo mã phòng / tên phòng
      const matchingRooms = await this.roomModel
        .find({
          $or: [{ room_code: searchRegex }, { room_name: searchRegex }],
        })
        .select('_id')
        .exec();
      const roomIds = matchingRooms.map((r) => r._id);

      filter.$or = [
        { invoice_code: searchRegex },
        { billing_month: searchRegex },
        { billing_period: searchRegex },
        ...(roomIds.length > 0 ? [{ room_id: { $in: roomIds } }] : []),
      ];
    }

    const page = query.page || 1;
    const limit = query.limit || 50;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.invoiceModel
        .find(filter)
        .populate({
          path: 'room_id',
          populate: { path: 'building_id', select: 'building_code name' },
        })
        .populate('student_id', 'student_code full_name')
        .populate('contract_id', 'contract_code')
        .populate('confirmed_by_id', 'user_name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.invoiceModel.countDocuments(filter),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<Invoice> {
    const invoice = await this.invoiceModel
      .findById(id)
      .populate({
        path: 'room_id',
        populate: { path: 'building_id', select: 'building_code name' },
      })
      .populate('roster_entry_ids')
      .populate('student_id', 'student_code full_name')
      .populate('contract_id', 'contract_code')
      .populate('confirmed_by_id', 'user_name full_name email')
      .exec();

    if (!invoice) {
      throw new NotFoundException(`Không tìm thấy hóa đơn: ${id}`);
    }
    return invoice;
  }

  private async resolveStudentRoom(userId: string): Promise<string> {
    const entries: any[] = await this.rosterModel.find({ identity_state: 'LINKED', room_id: { $exists: true, $ne: null } })
      .populate('student_id', '_id user_id status').sort({ createdAt: -1 }).exec();
    const entry: any = entries.find((candidate: any) => String(candidate.student_id?.user_id || '') === String(userId) && candidate.student_id?.status === 'Studying');
    if (!entry || !entry.student_id) throw new NotFoundException('Bạn chưa được xếp phòng KTX.');
    return String(entry.room_id?._id || entry.room_id);
  }

  async findMine(userId: string, query: any = {}) {
    return this.findAll({ ...query, room_id: await this.resolveStudentRoom(userId), student_id: undefined, contract_id: undefined });
  }

  async findOneMine(id: string, userId: string) {
    const roomId = await this.resolveStudentRoom(userId);
    const invoice: any = await this.findOne(id);
    if (String(invoice.room_id?._id || invoice.room_id || '') !== roomId) throw new NotFoundException('Không tìm thấy hóa đơn.');
    return invoice;
  }

  /**
   * UC08: Confirm payment with proof
   */
  async pay(id: string, dto: PayInvoiceDto, user: any): Promise<Invoice> {
    const invoice = await this.invoiceModel.findById(id).exec();
    if (!invoice) {
      throw new NotFoundException(`Không tìm thấy hóa đơn: ${id}`);
    }
    if (invoice.status === 'Đã thu' || invoice.status === 'Đã thanh toán') {
      throw new BadRequestException('Hóa đơn đã được thanh toán');
    }
    const config = await this.getUtilityConfig();
    if (!config.payment_deadline || new Date(config.payment_deadline) < new Date()) {
      throw new BadRequestException('Chưa cấu hình hạn thanh toán hợp lệ');
    }

    const hasTransferProof = dto.payment_method === 'Chuyển khoản' && !!(dto.payment_proof || dto.proof_url);
    invoice.status = hasTransferProof ? 'Chưa thu' : 'Đã thu';
    invoice.payment_method = dto.payment_method;
    invoice.paid_at = hasTransferProof ? undefined : new Date();
    invoice.confirmed_by_id = hasTransferProof ? undefined : (user._id || user.userId);
    invoice.notes = dto.notes || invoice.notes;

    if (dto.payment_proof) {
      invoice.payment_proof = {
        url: dto.payment_proof.url,
        file_name: dto.payment_proof.file_name,
        mime_type: dto.payment_proof.mime_type,
        size: dto.payment_proof.size,
        uploaded_at: new Date(),
      };
    } else if (dto.proof_url) {
      invoice.payment_proof = {
        url: dto.proof_url,
        uploaded_at: new Date(),
      };
    }
    if (hasTransferProof) invoice.payment_review = { status: 'pending', submitted_at: new Date() };

    const saved = await invoice.save();
    dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
      kind: 'utility',
      action: 'updated',
      id: saved?._id ? saved._id.toString() : (id ? id.toString() : undefined),
    });
    return saved;
  }

  /**
   * Cập nhật chứng từ thanh toán cho hóa đơn
   */
  async updatePaymentProof(
    id: string,
    dto: UpdatePaymentProofDto,
    user: any,
  ): Promise<Invoice> {
    const invoice = await this.invoiceModel.findById(id).exec();
    if (!invoice) {
      throw new NotFoundException(`Không tìm thấy hóa đơn: ${id}`);
    }
    const originalStatus = invoice.status;
    const originalReviewStatus = invoice.payment_review?.status;
    const update: any = { $set: {}, $unset: {} };
    if (dto.payment_method) { update.$set.payment_method = dto.payment_method; invoice.payment_method = dto.payment_method; }
    if (dto.notes !== undefined) { update.$set.notes = dto.notes; invoice.notes = dto.notes; }

    const isExplicitClear = dto.clear_proof || dto.payment_proof === null;
    if (isExplicitClear) {
      if (originalReviewStatus === 'approved') {
        throw new BadRequestException('Không thể xóa chứng từ đã được phê duyệt. Vui lòng thu hồi duyệt trước khi xóa.');
      }
      update.$unset.payment_proof = 1;
      update.$unset['payment_review.status'] = 1;
      update.$unset['payment_review.submitted_at'] = 1;
      update.$unset['payment_review.reviewed_by_id'] = 1;
      update.$unset['payment_review.reviewed_at'] = 1;
      invoice.payment_proof = undefined;
    } else if (dto.payment_proof) {
      invoice.payment_proof = {
        url: dto.payment_proof.url,
        file_name: dto.payment_proof.file_name,
        mime_type: dto.payment_proof.mime_type,
        size: dto.payment_proof.size,
        uploaded_at: new Date(),
      };
      update.$set.payment_proof = invoice.payment_proof;
    } else if (dto.proof_url) {
      invoice.payment_proof = {
        url: dto.proof_url,
        uploaded_at: new Date(),
      };
      update.$set.payment_proof = invoice.payment_proof;
    }

    if (!isExplicitClear && (dto.payment_proof || dto.proof_url)) {
      const submittedAt = new Date();
      invoice.payment_review = { ...invoice.payment_review, status: 'pending', submitted_at: submittedAt };
      update.$set['payment_review.status'] = 'pending';
      update.$set['payment_review.submitted_at'] = submittedAt;
      update.$unset['payment_review.reviewed_by_id'] = 1;
      update.$unset['payment_review.reviewed_at'] = 1;
      update.$unset['payment_review.revoked_by_id'] = 1;
      update.$unset['payment_review.revoked_at'] = 1;
      if (invoice.status === 'Đã thu' || invoice.status === 'Đã thanh toán') {
        invoice.status = 'Chưa thu';
        invoice.paid_at = undefined;
        invoice.confirmed_by_id = undefined;
        update.$set.status = 'Chưa thu';
        update.$unset.paid_at = 1;
        update.$unset.confirmed_by_id = 1;
      }
    }
    if (!Object.keys(update.$unset).length) delete update.$unset;
    const oldProofUrl = invoice.payment_proof?.url;
    const updateResult = await this.invoiceModel.updateOne(
      { _id: id, status: originalStatus, 'payment_review.status': originalReviewStatus },
      update,
    ).exec();
    if (updateResult.modifiedCount !== 1) throw new BadRequestException('Hóa đơn đã thay đổi, vui lòng tải lại trước khi cập nhật chứng từ');

    // Reference-safe cleanup of old proof file if replaced or cleared
    const isReplaced = (dto.payment_proof || dto.proof_url) && oldProofUrl !== (dto.payment_proof?.url || dto.proof_url);
    if (
      this.storageService &&
      oldProofUrl &&
      (isExplicitClear || isReplaced)
    ) {
      const remainingCount = await this.invoiceModel.countDocuments({
        'payment_proof.url': oldProofUrl,
      });
      if (remainingCount === 0) {
        const storageKey = this.storageService.extractStorageKey(oldProofUrl, 'private/invoices/proofs');
        if (storageKey && storageKey.startsWith('private/invoices/')) {
          await this.storageService
            .quarantineFile(storageKey, 'invoice_proof_replaced', user?.email || user?.username || 'user')
            .catch(() => {});
        }
      }
    }

    dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
      kind: 'utility',
      action: 'updated',
      id: id,
    });
    return invoice;

  }

  async reviewPaymentProof(id: string, decision: 'approved' | 'rejected' | 'revoked', user: any, requestId = `${decision}-${id}-${Date.now()}`): Promise<Invoice> {
    const invoice = await this.invoiceModel.findById(id).exec();
    if (!invoice) throw new NotFoundException(`Không tìm thấy hóa đơn: ${id}`);
    if (invoice.payment_method !== 'Chuyển khoản' || !invoice.payment_proof) throw new BadRequestException('Hóa đơn chưa có chứng từ chuyển khoản');
    if (decision === 'revoked') {
      if (invoice.payment_review?.status !== 'approved' || invoice.status !== 'Đã thu') throw new BadRequestException('Chứng từ không ở trạng thái đã duyệt');
      const now = new Date();
      const revokerId = user._id || user.userId;
      const updateResult = await this.invoiceModel.updateOne(
        { _id: id, payment_method: 'Chuyển khoản', 'payment_review.status': 'approved', status: 'Đã thu', payment_proof: { $exists: true } },
        { $set: { 'payment_review.status': 'pending', 'payment_review.revoked_by_id': revokerId, 'payment_review.revoked_at': now, status: 'Chưa thu' }, $unset: { paid_at: 1, confirmed_by_id: 1 } },
      ).exec();
      if (updateResult.modifiedCount !== 1) throw new BadRequestException('Chứng từ không ở trạng thái đã duyệt');
      invoice.payment_review = { ...invoice.payment_review, status: 'pending', revoked_by_id: revokerId, revoked_at: now };
      invoice.status = 'Chưa thu';
      invoice.paid_at = undefined;
      invoice.confirmed_by_id = undefined;
      dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
        kind: 'utility',
        action: 'updated',
        id: id,
      });
      return invoice;
    }
    if (invoice.payment_review?.status !== 'pending') throw new BadRequestException('Chứng từ không ở trạng thái chờ duyệt');
    const now = new Date();
    const reviewerId = user._id || user.userId;
    if (decision === 'approved') {
      const updateResult = await this.invoiceModel.updateOne(
        { _id: id, payment_method: 'Chuyển khoản', 'payment_review.status': 'pending', status: { $in: ['Chưa thu', 'Chưa thanh toán'] }, payment_proof: { $exists: true } },
        { $set: { 'payment_review.status': 'approved', 'payment_review.reviewed_by_id': reviewerId, 'payment_review.reviewed_at': now, status: 'Đã thu', paid_at: now, confirmed_by_id: reviewerId } },
      ).exec();
      if (updateResult.modifiedCount !== 1) throw new BadRequestException('Chứng từ không ở trạng thái chờ duyệt');
      invoice.payment_review = { ...invoice.payment_review, status: 'approved', reviewed_by_id: reviewerId, reviewed_at: now };
      invoice.status = 'Đã thu'; invoice.paid_at = now; invoice.confirmed_by_id = reviewerId;
    } else {
      const attempt = { decision: 'rejected' as const, reviewed_by_id: reviewerId, reviewed_at: now, request_id: requestId };
      const updateResult = await this.invoiceModel.updateOne(
        { _id: id, payment_method: 'Chuyển khoản', 'payment_review.status': 'pending', 'payment_review.attempts.request_id': { $ne: requestId }, status: { $in: ['Chưa thu', 'Chưa thanh toán'] }, payment_proof: { $exists: true } },
        { $push: { 'payment_review.attempts': attempt }, $set: { status: 'Chưa thu' }, $unset: { paid_at: 1, confirmed_by_id: 1 } },
      ).exec();
      if (updateResult.modifiedCount !== 1) throw new BadRequestException('Chứng từ không ở trạng thái chờ duyệt');
      invoice.payment_review = {
        ...invoice.payment_review,
        status: 'pending',
        attempts: [
          ...(invoice.payment_review?.attempts || []),
          attempt,
        ],
      };
      invoice.status = 'Chưa thu'; invoice.paid_at = undefined; invoice.confirmed_by_id = undefined;
    }
    dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
      kind: 'utility',
      action: 'updated',
      id: id,
    });
    return invoice;
  }

  async bulkReviewPaymentProof(ids: string[], decision: 'approved' | 'rejected', user: any, requestId: string) {
    const uniqueIds = [...new Set((ids || []).map(String).map((id) => id.trim()).filter(Boolean))];
    if (!uniqueIds.length) throw new BadRequestException('Danh sách ID hóa đơn không được rỗng');
    const results = await Promise.all(uniqueIds.map(async (id) => {
      try {
        const invoice = await this.reviewPaymentProof(id, decision, user, `${requestId}:${id}`);
        return { id, outcome: 'approved' as const, invoice };
      } catch (error: any) {
        const outcome = error?.status === 404 ? 'skipped' as const : 'failed' as const;
        return { id, outcome, error: error?.message || 'Không thể duyệt chứng từ' };
      }
    }));
    return { requested: uniqueIds.length, results };
  }

  /**
   * FR09: Get overdue summary
   */
  async getOverdueSummary() {
    const overdue = await this.invoiceModel
      .find({
        status: { $in: ['Chưa thu', 'Chưa thanh toán'] },
        due_date: { $lt: new Date() },
      })
      .populate('student_id', 'student_code full_name')
      .populate('room_id', 'room_code room_name')
      .sort({ due_date: 1 })
      .exec();

    return {
      total_overdue: overdue.length,
      total_amount: overdue.reduce((sum, inv) => sum + inv.total_amount, 0),
      invoices: overdue,
    };
  }

  /**
   * Tính toán định mức & đơn giá áp dụng cho phòng (override hoặc mặc định)
   */
  resolveEffectiveTariff(
    config: UtilityConfigDocument | UtilityConfig,
    roomId: string | Types.ObjectId,
  ) {
    const roomIdStr = String((roomId as any)?._id || roomId);

    const elecDefaultQuota = Number(config?.electricity?.quota_per_person ?? 15);
    const elecDefaultUnitPrice = Number(config?.electricity?.unit_price ?? 2500);
    const elecUnit = config?.electricity?.unit || 'kWh';

    const waterDefaultQuota = Number(config?.water?.quota_per_person ?? 4);
    const waterDefaultUnitPrice = Number(config?.water?.unit_price ?? 10000);
    const waterUnit = config?.water?.unit || 'm³';

    const elecQuotaOverrides = config?.electricity?.room_quota_overrides || [];
    const elecQuotaMatch = elecQuotaOverrides.find(
      (o: any) => String(o.room_id?._id || o.room_id) === roomIdStr,
    );

    const elecPriceOverrides = config?.electricity?.room_unit_price_overrides || [];
    const elecPriceMatch = elecPriceOverrides.find(
      (o: any) => String(o.room_id?._id || o.room_id) === roomIdStr,
    );

    const waterQuotaOverrides = config?.water?.room_quota_overrides || [];
    const waterQuotaMatch = waterQuotaOverrides.find(
      (o: any) => String(o.room_id?._id || o.room_id) === roomIdStr,
    );

    const waterPriceOverrides = config?.water?.room_unit_price_overrides || [];
    const waterPriceMatch = waterPriceOverrides.find(
      (o: any) => String(o.room_id?._id || o.room_id) === roomIdStr,
    );

    const elecQuota =
      elecQuotaMatch !== undefined && elecQuotaMatch.quota_per_person !== undefined
        ? Number(elecQuotaMatch.quota_per_person)
        : elecDefaultQuota;
    const elecUnitPrice =
      elecPriceMatch !== undefined && elecPriceMatch.unit_price !== undefined
        ? Number(elecPriceMatch.unit_price)
        : elecDefaultUnitPrice;

    const waterQuota =
      waterQuotaMatch !== undefined && waterQuotaMatch.quota_per_person !== undefined
        ? Number(waterQuotaMatch.quota_per_person)
        : waterDefaultQuota;
    const waterUnitPrice =
      waterPriceMatch !== undefined && waterPriceMatch.unit_price !== undefined
        ? Number(waterPriceMatch.unit_price)
        : waterDefaultUnitPrice;

    const elecQuotaSource: 'room_override' | 'default' =
      elecQuotaMatch !== undefined ? 'room_override' : 'default';
    const elecPriceSource: 'room_override' | 'default' =
      elecPriceMatch !== undefined ? 'room_override' : 'default';
    const elecAggregateSource: 'room_override' | 'default' =
      elecQuotaMatch !== undefined || elecPriceMatch !== undefined
        ? 'room_override'
        : 'default';

    const waterQuotaSource: 'room_override' | 'default' =
      waterQuotaMatch !== undefined ? 'room_override' : 'default';
    const waterPriceSource: 'room_override' | 'default' =
      waterPriceMatch !== undefined ? 'room_override' : 'default';
    const waterAggregateSource: 'room_override' | 'default' =
      waterQuotaMatch !== undefined || waterPriceMatch !== undefined
        ? 'room_override'
        : 'default';

    return {
      electricity: {
        quota_per_person: elecQuota,
        unit_price: elecUnitPrice,
        unit: elecUnit,
        quota_source: elecQuotaSource,
        unit_price_source: elecPriceSource,
        source: elecAggregateSource,
      },
      water: {
        quota_per_person: waterQuota,
        unit_price: waterUnitPrice,
        unit: waterUnit,
        quota_source: waterQuotaSource,
        unit_price_source: waterPriceSource,
        source: waterAggregateSource,
      },
    };
  }

  /**
   * Lấy cấu hình dùng chung điện - nước và hạn thu tự động
   */
  async getUtilityConfig(): Promise<UtilityConfigDocument> {
    let config = await this.utilityConfigModel
      .findOne()
      .populate({
        path: 'electricity.room_quota_overrides.room_id',
        select: 'room_code room_name building_id',
        populate: { path: 'building_id', select: 'building_code name' },
      })
      .populate({
        path: 'electricity.room_unit_price_overrides.room_id',
        select: 'room_code room_name building_id',
        populate: { path: 'building_id', select: 'building_code name' },
      })
      .populate({
        path: 'water.room_quota_overrides.room_id',
        select: 'room_code room_name building_id',
        populate: { path: 'building_id', select: 'building_code name' },
      })
      .populate({
        path: 'water.room_unit_price_overrides.room_id',
        select: 'room_code room_name building_id',
        populate: { path: 'building_id', select: 'building_code name' },
      })
      .exec();
    if (!config) {
      config = new this.utilityConfigModel({
        electricity: {
          quota_per_person: 15,
          unit_price: 2500,
          unit: 'kWh',
          room_quota_overrides: [],
          room_unit_price_overrides: [],
        },
        water: {
          quota_per_person: 4,
          unit_price: 10000,
          unit: 'm³',
          room_quota_overrides: [],
          room_unit_price_overrides: [],
        },
        payment_deadline: undefined,
      });
      await config.save();
    }
    return config;
  }

  /**
   * Cập nhật cấu hình dùng chung điện - nước và hạn thu tự động
   */
  async updateUtilityConfig(
    dto: UpdateUtilityConfigDto,
    user: any,
  ): Promise<UtilityConfigDocument> {
    let config = await this.utilityConfigModel.findOne().exec();
    if (!config) {
      config = new this.utilityConfigModel();
    }

    const validateQuotaOverrides = (
      overrides: any[] | undefined,
      utilityLabel: string,
    ) => {
      if (!overrides || !Array.isArray(overrides)) return [];
      const seen = new Set<string>();
      const normalized: Array<{ room_id: Types.ObjectId; quota_per_person: number }> = [];

      for (const item of overrides) {
        const idStr = String(item.room_id?._id || item.room_id || '').trim();
        if (!Types.ObjectId.isValid(idStr)) {
          throw new BadRequestException(
            `Mã phòng không hợp lệ trong cấu hình định mức ${utilityLabel}`,
          );
        }
        if (seen.has(idStr)) {
          throw new BadRequestException(
            `Phòng bị trùng lặp trong danh sách định mức ${utilityLabel} riêng`,
          );
        }
        const quota = Number(item.quota_per_person);
        if (isNaN(quota) || quota < 0) {
          throw new BadRequestException(
            `Định mức phòng trong ${utilityLabel} phải là số không âm`,
          );
        }
        seen.add(idStr);
        normalized.push({
          room_id: new Types.ObjectId(idStr),
          quota_per_person: quota,
        });
      }
      return normalized;
    };

    const validateUnitPriceOverrides = (
      overrides: any[] | undefined,
      utilityLabel: string,
    ) => {
      if (!overrides || !Array.isArray(overrides)) return [];
      const seen = new Set<string>();
      const normalized: Array<{ room_id: Types.ObjectId; unit_price: number }> = [];

      for (const item of overrides) {
        const idStr = String(item.room_id?._id || item.room_id || '').trim();
        if (!Types.ObjectId.isValid(idStr)) {
          throw new BadRequestException(
            `Mã phòng không hợp lệ trong cấu hình đơn giá ${utilityLabel}`,
          );
        }
        if (seen.has(idStr)) {
          throw new BadRequestException(
            `Phòng bị trùng lặp trong danh sách đơn giá ${utilityLabel} riêng`,
          );
        }
        const price = Number(item.unit_price);
        if (isNaN(price) || price < 0) {
          throw new BadRequestException(
            `Đơn giá phòng trong ${utilityLabel} phải là số không âm`,
          );
        }
        seen.add(idStr);
        normalized.push({
          room_id: new Types.ObjectId(idStr),
          unit_price: price,
        });
      }
      return normalized;
    };

    const elecQuotaOverrides = validateQuotaOverrides(
      dto.electricity?.room_quota_overrides,
      'điện',
    );
    const elecPriceOverrides = validateUnitPriceOverrides(
      dto.electricity?.room_unit_price_overrides,
      'điện',
    );
    const waterQuotaOverrides = validateQuotaOverrides(
      dto.water?.room_quota_overrides,
      'nước',
    );
    const waterPriceOverrides = validateUnitPriceOverrides(
      dto.water?.room_unit_price_overrides,
      'nước',
    );

    const allRoomIds = [
      ...elecQuotaOverrides.map((o) => o.room_id),
      ...elecPriceOverrides.map((o) => o.room_id),
      ...waterQuotaOverrides.map((o) => o.room_id),
      ...waterPriceOverrides.map((o) => o.room_id),
    ];
    if (allRoomIds.length > 0) {
      const existingRooms = await this.roomModel
        .find({ _id: { $in: allRoomIds } })
        .select('_id')
        .exec();
      const existingRoomIdSet = new Set(
        existingRooms.map((r) => String(r._id)),
      );
      for (const rId of allRoomIds) {
        if (!existingRoomIdSet.has(String(rId))) {
          throw new BadRequestException(
            `Không tìm thấy phòng với ID ${rId} trong hệ thống`,
          );
        }
      }
    }

    config.electricity = {
      quota_per_person: Number(dto.electricity.quota_per_person),
      unit_price: Number(dto.electricity.unit_price),
      unit: dto.electricity.unit || 'kWh',
      room_quota_overrides: elecQuotaOverrides as any,
      room_unit_price_overrides: elecPriceOverrides as any,
    };
    config.water = {
      quota_per_person: Number(dto.water.quota_per_person),
      unit_price: Number(dto.water.unit_price),
      unit: dto.water.unit || 'm³',
      room_quota_overrides: waterQuotaOverrides as any,
      room_unit_price_overrides: waterPriceOverrides as any,
    };
    if (dto.payment_deadline) {
      const deadline = new Date(dto.payment_deadline);
      if (isNaN(deadline.getTime())) throw new BadRequestException('Hạn thanh toán không hợp lệ');
      config.payment_deadline = deadline;
    }
    if (dto.configured_collection_days !== undefined) config.configured_collection_days = Number(dto.configured_collection_days);
    const oldQrUrl = config.transfer_qr_image?.url;
    if (dto.clear_qr) {
      config.transfer_qr_image = undefined;
    } else if (dto.transfer_qr_image) {
      config.transfer_qr_image = {
        url: dto.transfer_qr_image.url,
        file_name: dto.transfer_qr_image.file_name,
        mime_type: dto.transfer_qr_image.mime_type,
        size: dto.transfer_qr_image.size,
        uploaded_at: new Date(),
      };
    }
    if (user?._id || user?.userId) {
      config.updated_by_id = user._id || user.userId;
    }
    await config.save();

    const newQrUrl = config.transfer_qr_image?.url;
    if (this.storageService && oldQrUrl && oldQrUrl !== newQrUrl) {
      const utilCount = await this.utilityConfigModel.countDocuments({
        'transfer_qr_image.url': oldQrUrl,
      });
      let roomFeeCount = 0;
      if (this.roomFeeConfigModel) {
        roomFeeCount = await this.roomFeeConfigModel.countDocuments({
          'transfer_qr_image.url': oldQrUrl,
        });
      }
      if (utilCount + roomFeeCount === 0) {
        const storageKey = this.storageService.extractStorageKey(oldQrUrl, 'public/dormitory-qr');
        if (storageKey && storageKey.startsWith('public/dormitory-qr/')) {
          await this.storageService
            .quarantineFile(storageKey, 'utility_qr_replaced', user?.email || user?.username || 'user')
            .catch(() => {});
        }
      }
    }

    dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
      kind: 'utility',
      action: 'updated',
    });
    return this.getUtilityConfig();
  }

  /**
   * Lấy danh sách toàn bộ phòng cho kỳ thu kèm chỉ số cũ
   */
  async getMeterReadings(billingMonth: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(billingMonth)) {
      throw new BadRequestException(
        'Kỳ thu phải có định dạng YYYY-MM (ví dụ: 2026-03)',
      );
    }

    const config = await this.getUtilityConfig();

    // Lấy toàn bộ danh sách phòng trong hệ thống kèm thông tin tòa nhà
    const allRooms = await this.roomModel
      .find()
      .populate({ path: 'building_id', select: 'building_code name' })
      .exec();

    // Lấy danh sách roster entries có gắn phòng để tính số người ở
    const rosterEntries = await this.rosterModel
      .find({ room_id: { $ne: null } })
      .exec();

    // Nhóm roster entries theo room_id
    const rosterMap = new Map<
      string,
      { occupantCount: number; rosterEntryIds: Types.ObjectId[] }
    >();
    for (const entry of rosterEntries) {
      if (!entry.room_id) continue;
      const roomIdStr = String(
        (entry.room_id as any)?._id || entry.room_id,
      );
      if (!rosterMap.has(roomIdStr)) {
        rosterMap.set(roomIdStr, {
          occupantCount: 0,
          rosterEntryIds: [],
        });
      }
      const group = rosterMap.get(roomIdStr)!;
      group.occupantCount += 1;
      group.rosterEntryIds.push(entry._id);
    }

    const roomsData: any[] = [];
    for (const room of allRooms) {
      const roomIdStr = String(room._id);
      const rosterInfo = rosterMap.get(roomIdStr) || {
        occupantCount: 0,
        rosterEntryIds: [],
      };

      // Hóa đơn hiện tại trong kỳ này
      const currentInvoice = await this.invoiceModel
        .findOne({
          room_id: roomIdStr,
          billing_month: billingMonth,
        })
        .exec();

      // Hóa đơn gần nhất trước kỳ này
      const lastInvoice = this.meterReadingModel
        ? await this.meterReadingModel.findOne({ room_id: roomIdStr, billing_month: { $lt: billingMonth } }).sort({ billing_month: -1 }).exec()
        : await this.invoiceModel.findOne({ room_id: roomIdStr, billing_month: { $ne: billingMonth } }).sort({ billing_month: -1, reading_date: -1, createdAt: -1 }).exec();

      let previousElectricity = 0;
      let previousWater = 0;

      if (currentInvoice?.electricity?.previous_reading !== undefined) {
        previousElectricity = currentInvoice.electricity.previous_reading;
      } else if ((lastInvoice as any)?.electricity_reading !== undefined) {
        previousElectricity = (lastInvoice as any).electricity_reading;
      } else if ((lastInvoice as any)?.electricity?.current_reading !== undefined) {
        previousElectricity = (lastInvoice as any).electricity.current_reading;
      }

      if (currentInvoice?.water?.previous_reading !== undefined) {
        previousWater = currentInvoice.water.previous_reading;
      } else if ((lastInvoice as any)?.water_reading !== undefined) {
        previousWater = (lastInvoice as any).water_reading;
      } else if ((lastInvoice as any)?.water?.current_reading !== undefined) {
        previousWater = (lastInvoice as any).water.current_reading;
      }

      const effectiveTariffs = this.resolveEffectiveTariff(config, roomIdStr);

      roomsData.push({
        room_id: roomIdStr,
        room: room,
        occupant_count: rosterInfo.occupantCount,
        status: currentInvoice ? 'recorded' : 'unrecorded',
        invoice_id: currentInvoice?._id,
        invoice_status: currentInvoice?.status,
        invoice_code: currentInvoice?.invoice_code,
        previous_readings: {
          electricity: previousElectricity,
          water: previousWater,
        },
        current_readings: currentInvoice
          ? {
              electricity: currentInvoice.electricity?.current_reading,
              water: currentInvoice.water?.current_reading,
            }
          : undefined,
        total_amount: currentInvoice?.total_amount,
        is_exempt: currentInvoice?.is_exempt,
        notes: currentInvoice?.notes,
        payment_start_date: currentInvoice?.payment_start_date,
        due_date: currentInvoice?.due_date,
        effective_tariffs: effectiveTariffs,
      });
    }

    // Sắp xếp phòng theo tên / mã phòng
    roomsData.sort((a, b) => {
      const nameA = a.room?.room_name || a.room?.room_code || '';
      const nameB = b.room?.room_name || b.room?.room_code || '';
      return nameA.localeCompare(nameB, 'vi', { numeric: true });
    });

    return {
      config,
      billing_month: billingMonth,
      rooms: roomsData,
    };
  }

  /**
   * Lưu chỉ số điện - nước hàng loạt theo phòng (Idempotent per room)
   */
  async saveBulkMeterReadings(dto: BulkMeterReadingsDto, user: any) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(dto.billing_month)) {
      throw new BadRequestException(
        'Kỳ thu phải có định dạng YYYY-MM (ví dụ: 2026-03)',
      );
    }

    const config = await this.getUtilityConfig();
    const results: Array<{
      room_id: string;
      success: boolean;
      invoice?: any;
      error?: string;
    }> = [];

    const now = new Date();
    let dueDate = config.payment_deadline && new Date(config.payment_deadline) >= now
      ? new Date(config.payment_deadline) : undefined;
    if (!dueDate) {
      const days = config.configured_collection_days && config.configured_collection_days > 0 ? config.configured_collection_days : 7;
      dueDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    }

    for (const item of dto.readings || []) {
      let meterPayload: {
        electricity_reading: number;
        water_reading: number;
        reading_date: Date;
        occupant_count: number;
        roster_entry_ids: any[];
      } | undefined;
      try {
        if (!Types.ObjectId.isValid(item.room_id)) {
          throw new BadRequestException('Mã phòng không hợp lệ');
        }

        const room = await this.roomModel.findById(item.room_id).exec();
        if (!room) {
          throw new NotFoundException(`Không tìm thấy phòng: ${item.room_id}`);
        }

        const rosterEntries = await this.rosterModel
          .find({ room_id: item.room_id })
          .exec();
        const rosterEntryIds = rosterEntries.map((r) => r._id);
        const occupantCount = rosterEntries.length;

        // Tìm hóa đơn hiện tại trong kỳ nếu có
        const existingInvoice = await this.invoiceModel
          .findOne({
            room_id: item.room_id,
            billing_month: dto.billing_month,
          })
          .exec();

        let prevElec = 0;
        let prevWater = 0;

        if (existingInvoice) {
          if (
            existingInvoice.status === 'Đã thu' ||
            existingInvoice.status === 'Đã thanh toán'
          ) {
            throw new BadRequestException(
              'Không thể chỉnh sửa hóa đơn đã thu',
            );
          }
          prevElec = existingInvoice.electricity?.previous_reading ?? 0;
          prevWater = existingInvoice.water?.previous_reading ?? 0;
        } else {
          const lastInvoice = await this.invoiceModel
            .findOne({
              room_id: item.room_id,
              billing_month: { $lt: dto.billing_month },
            })
            .sort({ billing_month: -1, reading_date: -1, createdAt: -1 })
            .exec();

          prevElec = lastInvoice?.electricity?.current_reading ?? 0;
          prevWater = lastInvoice?.water?.current_reading ?? 0;

          if (this.meterReadingModel) {
            const lastReading = await this.meterReadingModel
              .findOne({
                room_id: item.room_id,
                billing_month: { $lt: dto.billing_month },
              })
              .sort({ billing_month: -1, reading_date: -1 })
              .exec();
            if (lastReading) {
              if (lastReading.electricity_reading !== undefined && lastReading.electricity_reading !== null) {
                prevElec = lastReading.electricity_reading;
              }
              if (lastReading.water_reading !== undefined && lastReading.water_reading !== null) {
                prevWater = lastReading.water_reading;
              }
            }
          }
        }

        if (item.previous_electricity_reading !== undefined && item.previous_electricity_reading !== null) {
          const customPrevElec = Number(item.previous_electricity_reading);
          if (!isNaN(customPrevElec) && customPrevElec >= 0) {
            prevElec = customPrevElec;
          }
        }
        if (item.previous_water_reading !== undefined && item.previous_water_reading !== null) {
          const customPrevWater = Number(item.previous_water_reading);
          if (!isNaN(customPrevWater) && customPrevWater >= 0) {
            prevWater = customPrevWater;
          }
        }

        const currElec = Number(item.electricity_reading);
        const currWater = Number(item.water_reading);

        if (isNaN(currElec) || isNaN(currWater)) {
          throw new BadRequestException(
            'Chỉ số điện và nước phải là số hợp lệ',
          );
        }
        if (currElec < 0 || currWater < 0) {
          throw new BadRequestException('Chỉ số không được là số âm');
        }
        if (currElec < prevElec) {
          throw new BadRequestException(
            'Chỉ số điện mới không được nhỏ hơn chỉ số cũ',
          );
        }
        if (currWater < prevWater) {
          throw new BadRequestException(
            'Chỉ số nước mới không được nhỏ hơn chỉ số cũ',
          );
        }

        meterPayload = { electricity_reading: currElec, water_reading: currWater, reading_date: now, occupant_count: occupantCount, roster_entry_ids: rosterEntryIds };
        if (this.meterReadingModel) {
          await this.meterReadingModel.findOneAndUpdate(
            { room_id: item.room_id, billing_month: dto.billing_month },
            { $set: meterPayload },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
          ).exec();
        }

        const effectiveTariffs = this.resolveEffectiveTariff(config, item.room_id);
        const isExempt = Boolean(item.is_exempt);
        const electricity = this.calculateUtility(
          occupantCount,
          {
            previous_reading: prevElec,
            current_reading: currElec,
            quota_per_person: effectiveTariffs.electricity.quota_per_person,
            unit_price: effectiveTariffs.electricity.unit_price,
          },
          isExempt,
        );

        const water = this.calculateUtility(
          occupantCount,
          {
            previous_reading: prevWater,
            current_reading: currWater,
            quota_per_person: effectiveTariffs.water.quota_per_person,
            unit_price: effectiveTariffs.water.unit_price,
          },
          isExempt,
        );

        const total_amount = isExempt ? 0 : electricity.amount + water.amount;

        if (existingInvoice) {
          existingInvoice.reading_date = now;
          existingInvoice.payment_start_date = now;
          if (dueDate) existingInvoice.due_date = dueDate;
          existingInvoice.occupant_count = occupantCount;
          existingInvoice.roster_entry_ids = rosterEntryIds;
          existingInvoice.electricity = electricity;
          existingInvoice.water = water;
          existingInvoice.total_amount = total_amount;
          existingInvoice.is_exempt = isExempt;
          if (item.notes !== undefined) {
            existingInvoice.notes = item.notes;
          }
          const saved = await existingInvoice.save();
          results.push({
            room_id: item.room_id,
            success: true,
            invoice: saved,
          });
        } else {
          const invoice = new this.invoiceModel({
            invoice_code: `INV-${randomUUID().substring(0, 8).toUpperCase()}`,
            room_id: item.room_id,
            billing_month: dto.billing_month,
            reading_date: now,
            occupant_count: occupantCount,
            roster_entry_ids: rosterEntryIds,
            electricity,
            water,
            is_exempt: isExempt,
            payment_start_date: now,
            ...(dueDate ? { due_date: dueDate } : {}),
            total_amount,
            status: 'Chưa thu',
            notes: item.notes,
          });
          const saved = await invoice.save();
          results.push({
            room_id: item.room_id,
            success: true,
            invoice: saved,
          });
        }
      } catch (err: any) {
        if (err?.code === 11000 && this.isCanonicalDuplicate(err, 'meter')) {
          try {
            // Re-enter the idempotent unit after the canonical meter race. The
            // second pass sees the existing invoice and recomputes its full
            // snapshot instead of returning a meter-only success.
            const retry = await this.saveBulkMeterReadings(
              { billing_month: dto.billing_month, readings: [item] } as BulkMeterReadingsDto,
              user,
            );
            results.push(retry.results[0]);
            continue;
          } catch (retryError: any) {
            err = retryError;
          }
        } else if (err?.code === 11000 && this.isCanonicalDuplicate(err, 'invoice')) {
          const retry = await this.saveBulkMeterReadings(
            { billing_month: dto.billing_month, readings: [item] } as BulkMeterReadingsDto,
            user,
          );
          results.push(retry.results[0]);
          continue;
        }
        results.push({
          room_id: item.room_id,
          success: false,
          error: err?.message || 'Lỗi khi lưu chỉ số phòng',
        });
      }
    }

    const successfulIds = results.filter((r) => r.success && r.invoice?._id).map((r) => r.invoice._id.toString());
    if (successfulIds.length > 0) {
      dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
        kind: 'utility',
        action: 'updated',
        ids: successfulIds,
      });
    }

    return { results };
  }

  private isCanonicalDuplicate(error: any, collection: 'meter' | 'invoice') {
    const text = [error?.collection, error?.modelName, error?.index, error?.keyPattern, error?.message]
      .filter(Boolean).join(' ').toLowerCase();
    const hasCanonicalKey = text.includes('room_id') && text.includes('billing_month');
    const hasCollection = collection === 'meter'
      ? /meter(reading)?/.test(text)
      : /invoice/.test(text);
    return hasCanonicalKey && (hasCollection || !error?.collection && !error?.modelName && !error?.index);
  }

  /**
   * Xóa nhiều hóa đơn theo danh sách ID
   */
  async bulkDelete(ids: string[], user: any) {
    // Normalize and deduplicate IDs
    const uniqueIds = Array.from(
      new Set((ids || []).map((id) => (id ? String(id).trim() : '')).filter(Boolean)),
    );

    if (uniqueIds.length === 0) {
      throw new BadRequestException('Danh sách ID hóa đơn không hợp lệ');
    }

    const validObjectIds: Types.ObjectId[] = [];
    const rejected: Array<{ id: string; invoice_code?: string; reason: string }> = [];
    const not_found: string[] = [];

    for (const idStr of uniqueIds) {
      if (Types.ObjectId.isValid(idStr)) {
        validObjectIds.push(new Types.ObjectId(idStr));
      } else {
        rejected.push({
          id: idStr,
          reason: 'Mã hóa đơn không hợp lệ',
        });
      }
    }

    const deletableIds: Types.ObjectId[] = [];
    const deletedIdStrings: string[] = [];

    if (validObjectIds.length > 0) {
      const existingInvoices = await this.invoiceModel
        .find({ _id: { $in: validObjectIds } })
        .exec();

      const existingMap = new Map<string, any>();
      for (const inv of existingInvoices) {
        existingMap.set(String(inv._id), inv);
      }

      for (const objId of validObjectIds) {
        const idStr = String(objId);
        const inv = existingMap.get(idStr);

        if (!inv) {
          not_found.push(idStr);
        } else if (inv.status === 'Đã thu' || inv.status === 'Đã thanh toán') {
          rejected.push({
            id: idStr,
            invoice_code: inv.invoice_code,
            reason: 'Không thể xóa hóa đơn đã thanh toán',
          });
        } else {
          deletableIds.push(objId);
          deletedIdStrings.push(idStr);
        }
      }

      if (deletableIds.length > 0) {
        const proofUrlsToCheck: string[] = [];
        for (const objId of deletableIds) {
          const inv = existingMap.get(String(objId));
          if (inv?.payment_proof?.url) {
            proofUrlsToCheck.push(inv.payment_proof.url);
          }
        }

        await this.invoiceModel
          .deleteMany({ _id: { $in: deletableIds } })
          .exec();

        // Reference-safe storage cleanup after DB success
        if (this.storageService && proofUrlsToCheck.length > 0) {
          for (const proofUrl of proofUrlsToCheck) {
            const remainingCount = await this.invoiceModel.countDocuments({
              'payment_proof.url': proofUrl,
            });
            if (remainingCount === 0) {
              const storageKey = this.storageService.extractStorageKey(proofUrl, 'private/invoices/proofs');
              if (storageKey && storageKey.startsWith('private/invoices/')) {
                await this.storageService
                  .quarantineFile(storageKey, 'invoice_bulk_deleted', 'system')
                  .catch(() => {});
              }
            }
          }
        }

        dormitoryInvoiceEventEmitter.emit('dormitory_invoice_event', {
          kind: 'utility',
          action: 'deleted',
          ids: deletedIdStrings,
        });
      }

    }

    return {
      requested: uniqueIds.length,
      deleted: deletedIdStrings,
      not_found,
      rejected,
    };
  }
}
