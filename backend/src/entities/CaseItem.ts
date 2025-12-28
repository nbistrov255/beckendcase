import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "typeorm";
import { Case } from "./Case";
import { Item } from "./Item";

@Entity()
export class CaseItem {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => Case, (c) => c.items)
    case!: Case;

    @ManyToOne(() => Item)
    item!: Item;

    @Column("float")
    chance!: number; // Шанс выпадения (например, 0.05 = 5%)
}
