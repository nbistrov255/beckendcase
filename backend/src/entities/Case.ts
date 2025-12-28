import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";
import { CaseItem } from "./CaseItem";

@Entity()
export class Case {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @Column({ nullable: true })
    image_url!: string;

    @Column("decimal", { precision: 10, scale: 2 })
    price!: number; // Цена открытия

    @Column({ default: true })
    is_active!: boolean;

    @OneToMany(() => CaseItem, (caseItem) => caseItem.case)
    items!: CaseItem[];
}
