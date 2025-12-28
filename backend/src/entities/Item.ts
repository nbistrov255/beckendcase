import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class Item {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @Column({ nullable: true })
    image_url!: string;

    @Column("decimal", { precision: 10, scale: 2 })
    price!: number; // Цена предмета (для продажи/отображения)

    @Column({ default: 0 })
    stock!: number; // Сколько штук на складе (0 = нет в наличии)
}
